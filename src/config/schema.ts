/**
 * Corral configuration schema (v1, evolving).
 *
 * Every value is user-supplied — there are no project-specific defaults baked in.
 * Secrets are never inline: config holds a CredentialRef pointer; the secret lives
 * in a CredentialStore (see ../credentials/types.ts). Project/language specifics
 * live under `profile` (the de-masil seam), not in code.
 *
 * `kind` discriminators line up with the per-axis registries (../core/registry.ts).
 */
import { z } from 'zod';

// ───────────────────────────────────────────────────────────── shared

export const CredentialRefSchema = z.object({
  service: z.string().min(1),
  account: z.string().min(1).default('default'),
});

/** Project/language specifics — keeps trackers/prompts free of hardcoded conventions. */
export const ProfileSchema = z.object({
  /** Output language for agent-authored docs (plans, reviews), e.g. "en", "ko". */
  language: z.string().default('en'),
  /** Calibration profile id for review examples/thresholds, e.g. "generic", "nestjs". */
  stack: z.string().default('generic'),
  /** Optional conventions/skills repo cloned read-only alongside the work repos.
   *  "owner/name" (GitHub) or a full https git URL. The agent consults it for
   *  conventions but never commits to it. */
  reference_repo: z.string().optional(),
  /** Credential for a private reference repo (omit for a public one). */
  reference_credential: CredentialRefSchema.optional(),
});

// ───────────────────────────────────────────────────────────── axis 1: tracker

/**
 * Semantic states map Corral's pipeline stages onto the tracker's own columns.
 * Only three are functionally required — an entry column to pick work up
 * (`planning`), a working column (`in_progress`), and a terminal column (`done`).
 * `plan_review` (plan-approval gate) and `in_review` (PR open) are board-display
 * refinements: omit them on a coarse board and they collapse onto an existing
 * column (plan_review→planning, in_review→in_progress). Several stages mapping to
 * one column is fine — the reverse map keeps the first (entry) semantic.
 */
const SemanticStatesSchema = z
  .object({
    planning: z.string(),
    plan_review: z.string().optional(),
    in_progress: z.string(),
    in_review: z.string().optional(),
    done: z.string(),
    canceled: z.string().optional(),
  })
  .transform((s) => ({
    planning: s.planning,
    plan_review: s.plan_review ?? s.planning,
    in_progress: s.in_progress,
    in_review: s.in_review ?? s.in_progress,
    done: s.done,
    canceled: s.canceled,
  }));

/** Optional gate restricting which issues Corral picks up (a checkbox, or a
 * select/status property matching given values). */
const NotionScopeSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('checkbox'), property: z.string(), checked: z.boolean().default(true) }),
    z.object({ type: z.literal('select'), property: z.string(), values: z.array(z.string()) }),
    z.object({ type: z.literal('multi_select'), property: z.string(), values: z.array(z.string()) }),
    z.object({ type: z.literal('status'), property: z.string(), values: z.array(z.string()) }),
  ])
  .optional();

const NotionTrackerSchema = z.object({
  kind: z.literal('notion'),
  database_id: z.string().min(1),
  credential: CredentialRefSchema,
  /** Map semantic IssueState → the tracker's own status value. */
  states: SemanticStatesSchema,
  properties: z.object({
    status: z.string(),
    identifier: z.string(),
    /** Property that routes an issue to a repository `key`. */
    repo: z.string().optional(),
  }),
  scope: NotionScopeSchema,
  poll_interval_ms: z.number().int().positive().default(30_000),
});

/** GitHub Issues tracker — semantic states map to issue labels; closing = done.
 * Proves the tracker axis is not Notion-bound (anything with an API can be added). */
const GithubIssuesTrackerSchema = z.object({
  kind: z.literal('github_issues'),
  /** "owner/name" the issues live in. */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
  credential: CredentialRefSchema,
  /** Map semantic IssueState → a GitHub label name. */
  states: SemanticStatesSchema,
  /** Only issues carrying this label are candidates (optional gate). */
  scope_label: z.string().optional(),
  /** Routing key → repository adapter; defaults to the first repository. */
  repo_key: z.string().optional(),
  /** Prefix for branch/container/log identifiers (e.g. "issue-" → issue-123). */
  identifier_prefix: z.string().default('issue-'),
});

/** Jira Cloud tracker — semantic states map to Jira workflow status names; auth is
 * email + API token (Basic). */
const JiraTrackerSchema = z.object({
  kind: z.literal('jira'),
  /** Site base URL, e.g. https://your-team.atlassian.net */
  host: z.string().min(1),
  /** Project key, e.g. "ISS". */
  project: z.string().min(1),
  /** Account email (paired with the API token credential for Basic auth). */
  email: z.string().min(1),
  credential: CredentialRefSchema,
  /** Map semantic IssueState → a Jira status name. */
  states: SemanticStatesSchema,
  /** Routing key → repository adapter; defaults to the first repository. */
  repo_key: z.string().optional(),
});

export const TrackerSchema = z.discriminatedUnion('kind', [
  NotionTrackerSchema,
  GithubIssuesTrackerSchema,
  JiraTrackerSchema,
]);

// ────────────────────────────────────────────────────────── axis 2: repository

/** Fields shared by every repository provider. */
const repoCommon = {
  /** Stable id for this repo (workspace subdir, routing, per-repo PR tracking). */
  key: z.string().min(1),
  /** "owner/name" (GitHub/GitLab) or "workspace/slug" (Bitbucket). */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
  /** What this repo is — the agent uses this to decide which repo an issue touches. */
  description: z.string().default(''),
  credential: CredentialRefSchema,
  branch_strategy: z
    .object({
      production: z.string().default('main'),
      development: z.string().default('develop'),
      /** Issue labels that route work onto the production branch (hotfix). */
      hotfix_labels: z.array(z.string()).default([]),
    })
    .default({ production: 'main', development: 'develop', hotfix_labels: [] }),
  branch_prefix: z.string().default(''),
  /** Static verification commands (lint/typecheck/analyze). */
  verify: z.array(z.string()).default([]),
  /** Hook run once after clone (e.g. "npm ci"). */
  after_clone: z.string().optional(),
  /** Per-repo worker image override. */
  image: z.string().optional(),
};

const GithubRepositorySchema = z.object({ kind: z.literal('github'), ...repoCommon });

const GitlabRepositorySchema = z.object({
  kind: z.literal('gitlab'),
  /** Self-hosted GitLab base URL; defaults to gitlab.com. */
  host: z.string().default('https://gitlab.com'),
  ...repoCommon,
});

const BitbucketRepositorySchema = z.object({
  kind: z.literal('bitbucket'),
  /** Bitbucket username (paired with an app password for Basic auth + clone). */
  username: z.string().min(1),
  ...repoCommon,
});

export const RepositorySchema = z.discriminatedUnion('kind', [
  GithubRepositorySchema,
  GitlabRepositorySchema,
  BitbucketRepositorySchema,
]);

// ─────────────────────────────────────────────────────────────── axis 3: agent

export const StageModelsSchema = z
  .object({
    planning: z.string().optional(),
    implementation: z.string().optional(),
    review: z.string().optional(),
  })
  .default({});

/** Routing + per-stage models for one agent — the fields that differ between a
 *  primary agent and each ordered fallback. Execution limits (turns/budget/timeout)
 *  are NOT here: they live on the primary and apply uniformly to whichever agent
 *  ends up running the turn. */
export const AgentRoutingSchema = z.object({
  provider: z.enum(['claude', 'gemini', 'gpt']),
  transport: z.enum(['api', 'cli']).default('api'),
  /** Required for `api` (BYOK); for `cli` the user's own CLI login is used. */
  credential: CredentialRefSchema.optional(),
  /** Claude subscription OAuth token (from `claude setup-token`), injected as
   *  CLAUDE_CODE_OAUTH_TOKEN — lets the cli authenticate in a container with NO API
   *  key (subscription, not pay-per-use). */
  oauth_credential: CredentialRefSchema.optional(),
  models: StageModelsSchema,
});

const requireApiCredential = (agent: { transport: string; credential?: unknown }, ctx: z.RefinementCtx, path: (string | number)[]) => {
  if (agent.transport === 'api' && !agent.credential) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'api transport requires a credential (BYOK)' });
  }
};

export const AgentSchema = AgentRoutingSchema.extend({
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  turn_timeout_ms: z.number().int().positive().default(3_600_000),
  allowed_tools: z.array(z.string()).default([]),
  /** Ordered fallback agents. When the active agent's usage is exhausted (rate limit /
   *  account ended → rate_limit/auth/budget), the orchestrator advances to the next
   *  one. Empty = single-agent (no failover). */
  fallbacks: z.array(AgentRoutingSchema).default([]),
}).superRefine((agent, ctx) => {
  requireApiCredential(agent, ctx, ['credential']);
  agent.fallbacks.forEach((fb, i) => requireApiCredential(fb, ctx, ['fallbacks', i, 'credential']));
});

// ─────────────────────────────────────────────────────────── axis 4: workspace

export const WorkspaceSchema = z
  .object({
    backend: z.enum(['docker', 'local']).default('local'),
    /** Local backend: host dir under which each issue's repo is cloned. */
    root: z.string().default('.corral-workspaces'),
    docker: z
      .object({
        /** Pre-built worker image to use (BYO). Omit to auto-build one (see auto_build). */
        image: z.string().optional(),
        /** When no `image` is set, auto-build a worker image from the repos' manifests
         *  (analyze on the host → generate Dockerfile → build). */
        auto_build: z.boolean().default(true),
        /** Mount the host `~/.claude` login into the container (read-only) so the CLI
         *  authenticates like the local backend — no API key needed. Off → inject an
         *  API key instead. */
        mount_host_login: z.boolean().default(true),
        memory: z.string().optional(),
        cpus: z.string().optional(),
        /** Extra env injected into the worker container. */
        env: z.record(z.string()).optional(),
      })
      .optional(),
  })
  .default({});

// ───────────────────────────────────────────────────────────── axis 5: channel

export const ChannelSchema = z
  .object({
    kind: z.enum(['web', 'slack']).default('web'),
    port: z.number().int().positive().default(4400),
  })
  .default({ kind: 'web', port: 4400 });

// ─────────────────────────────────────────────────────── review / plan-review

const SemgrepSchema = z
  .object({
    config: z.array(z.string()).default(['p/default']),
    paths: z.array(z.string()).default(['.']),
  })
  .optional();

export const ReviewSchema = z
  .object({
    /** Fixed number of independent review rounds (fresh sessions) for EVERY issue.
     *  No adaptive depth — diff line count measures size, not risk, so it's not used
     *  to scale rounds. The static gate (lint/typecheck) always runs once on top. */
    rounds: z.number().int().positive().default(1),
    /** Auto-fix loop: max review→fix→re-review cycles before handing to a human.
     *  Default 0 = fully manual: review runs ONCE, then the human decides (approve = PR,
     *  or text feedback = edit code + re-review once). Set >0 to re-enable auto-fixing.
     *  The cost driver was "Opus output × automatic re-review" — keep depth, cut count. */
    max_fix_rounds: z.number().int().nonnegative().default(0),
    /** Open the PR automatically when self-review is clean (no blocker/suggestion). */
    auto_pr_when_clean: z.boolean().default(false),
    /** Optional semgrep static analysis (omit to skip). */
    semgrep: SemgrepSchema,
  })
  .default({});

export const PlanReviewSchema = z
  .object({
    enabled: z.boolean().default(true),
    rounds: z.number().int().positive().default(1),
    heavy_labels: z.array(z.string()).default([]),
    heavy_rounds: z.number().int().positive().default(2),
  })
  .default({});

// ─────────────────────────────────────────────────────────────────── top-level

export const ConfigSchema = z.object({
  profile: ProfileSchema.default({ language: 'en', stack: 'generic' }),
  tracker: TrackerSchema,
  repositories: z.array(RepositorySchema).min(1),
  agent: AgentSchema,
  workspace: WorkspaceSchema,
  channel: ChannelSchema,
  review: ReviewSchema,
  plan_review: PlanReviewSchema,
  /** Max issues active (workspaces) at once. */
  max_active_issues: z.number().int().positive().default(3),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TrackerConfig = z.infer<typeof TrackerSchema>;
export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentRoutingConfig = z.infer<typeof AgentRoutingSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type CredentialRefConfig = z.infer<typeof CredentialRefSchema>;
export type ReviewConfig = z.infer<typeof ReviewSchema>;
export type PlanReviewConfig = z.infer<typeof PlanReviewSchema>;
