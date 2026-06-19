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
  /** Optional conventions/skills repo cloned read-only alongside the work repo. */
  reference_repo: z.string().optional(),
});

// ───────────────────────────────────────────────────────────── axis 1: tracker

const SemanticStatesSchema = z.object({
  planning: z.string(),
  plan_review: z.string(),
  in_progress: z.string(),
  in_review: z.string(),
  done: z.string(),
  canceled: z.string().optional(),
});

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

export const TrackerSchema = z.discriminatedUnion('kind', [NotionTrackerSchema, GithubIssuesTrackerSchema]);

// ────────────────────────────────────────────────────────── axis 2: repository

const GithubRepositorySchema = z.object({
  kind: z.literal('github'),
  /** Routing key matched against the tracker's repo property / Issue.repoKey. */
  key: z.string().min(1),
  /** "owner/name". */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
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
});

export const RepositorySchema = z.discriminatedUnion('kind', [GithubRepositorySchema]);

// ─────────────────────────────────────────────────────────────── axis 3: agent

export const StageModelsSchema = z
  .object({
    planning: z.string().optional(),
    implementation: z.string().optional(),
    review: z.string().optional(),
  })
  .default({});

export const AgentSchema = z
  .object({
    provider: z.enum(['claude', 'gemini', 'gpt']),
    transport: z.enum(['api', 'cli']).default('api'),
    /** Required for `api` (BYOK); for `cli` the user's own CLI login is used. */
    credential: CredentialRefSchema.optional(),
    models: StageModelsSchema,
    max_turns: z.number().int().positive().optional(),
    max_budget_usd: z.number().positive().optional(),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
    allowed_tools: z.array(z.string()).default([]),
  })
  .superRefine((agent, ctx) => {
    if (agent.transport === 'api' && !agent.credential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential'],
        message: 'api transport requires a credential (BYOK)',
      });
    }
  });

// ─────────────────────────────────────────────────────────── axis 4: workspace

export const WorkspaceSchema = z
  .object({
    backend: z.enum(['docker', 'local']).default('local'),
    /** Local backend: host dir under which each issue's repo is cloned. */
    root: z.string().default('.corral-workspaces'),
    docker: z
      .object({
        image: z.string().default('corral-worker:latest'),
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

const AdaptiveSchema = z
  .object({
    enabled: z.boolean().default(false),
    heavy: z
      .object({
        min_diff_lines: z.number().int().positive().default(300),
        labels: z.array(z.string()).default([]),
        rounds: z.number().int().positive().default(3),
      })
      .default({}),
    light: z
      .object({
        max_diff_lines: z.number().int().positive().default(50),
        max_files: z.number().int().positive().default(3),
        rounds: z.number().int().positive().default(1),
      })
      .default({}),
  })
  .default({});

export const ReviewSchema = z
  .object({
    /** Independent review rounds (fresh sessions) per cycle. */
    rounds: z.number().int().positive().default(1),
    /** Max auto-fix → re-review cycles before handing to a human. */
    max_fix_rounds: z.number().int().nonnegative().default(2),
    /** Open the PR automatically when self-review is clean (no blocker/suggestion). */
    auto_pr_when_clean: z.boolean().default(false),
    adaptive: AdaptiveSchema,
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
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type CredentialRefConfig = z.infer<typeof CredentialRefSchema>;
export type ReviewConfig = z.infer<typeof ReviewSchema>;
export type PlanReviewConfig = z.infer<typeof PlanReviewSchema>;
