/**
 * Domain models + the 5-axis pluggable adapter interfaces.
 *
 * Every external integration sits behind one of these interfaces. The config's
 * `kind` field (a zod discriminated union) selects the concrete implementation,
 * resolved through a Registry (see ./registry.ts).
 *
 *   axis        interface                          reference impls
 *   tracker     TrackerAdapter                     notion
 *   repository  RepositoryAdapter                  github
 *   agent       AgentAdapter                       claude (provider × transport, see ../agent/types.ts)
 *   workspace   WorkspaceAdapter + WorkspaceIO     docker, local
 *   channel     ChannelAdapter                     web, slack
 *
 * These signatures are deliberately kept compatible with the upstream orchestrator
 * so the core logic can be lifted in one pass (see docs/development-plan.md §1.3).
 */

// ───────────────────────────────────────────────────────────── domain models
// Tracker-neutral normalized models. Each tracker adapter converts its own API
// response into these shapes so the orchestrator never sees Notion/Jira/etc.

/** Semantic tracker states (mapped to per-tracker state names via config). */
export type IssueState =
  | 'planning'
  | 'plan_review'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled';

/** Terminal states trigger workspace cleanup. */
export const TERMINAL_STATES: ReadonlySet<IssueState> = new Set(['done', 'canceled']);

/** A file attached in the tracker page body. */
export type AttachmentKind = 'md' | 'pdf' | 'image' | 'other';
export interface Attachment {
  kind: AttachmentKind;
  /** Display filename (e.g. "spec.md"). */
  name: string;
  /** Source URL — some trackers sign URLs that expire, so fetch promptly. */
  url: string;
}

export interface Issue {
  /** Stable human identifier — used as branch / container / log-file key. e.g. "ISS-131". */
  identifier: string;
  /** Tracker-internal id (e.g. Notion page id) for write-back calls. */
  internalId: string;
  title: string;
  /** Plain-text flattened body / description. */
  description: string;
  /** Semantic state resolved via the config `states` mapping. */
  state: IssueState;
  /** Labels / tags (drives repo routing, hotfix detection, agent triggers). */
  labels: string[];
  /** Identifiers of issues this one "is blocked by" (dispatch held until they're terminal). */
  blockedBy: string[];
  /** Repo routing key resolved from a tracker property. */
  repoKey?: string;
  url?: string;
  /** Files attached in the page body (hydrated alongside description). */
  attachments: Attachment[];
}

export interface TrackerComment {
  id: string;
  /** Author identity string (to distinguish bot vs human comments). */
  author: string;
  body: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
  merged: boolean;
}

export interface PullRequestComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface BotIdentity {
  id: string;
  name: string;
}

// ─────────────────────────────────────────────────────────── axis 1: tracker

export interface TrackerAdapter {
  readonly kind: string;
  /** Issues currently in a state Corral acts on. */
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;
  /** Move the issue to a semantic state (writes the mapped tracker state name). */
  transitionIssue(issue: Issue, to: IssueState): Promise<void>;
  createComment(issue: Issue, body: string): Promise<void>;
  /** Comments created after `since` (ISO). Used for workpad / PR-feedback polling. */
  fetchComments(issue: Issue, since?: string): Promise<TrackerComment[]>;
  getBotIdentity(): Promise<BotIdentity>;
}

// ──────────────────────────────────────────────────────── axis 2: repository

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface RepositoryAdapter {
  readonly kind: string;
  /** Stable key used to route issues → repository (matches Issue.repoKey / config). */
  readonly key: string;
  /** Human description of this repo's role — surfaced to the agent so it can decide
   * which repo(s) an issue touches when several are cloned side by side. */
  readonly description: string;
  readonly baseBranchFor: (issue: Issue) => string;
  /** Work branch the agent creates for an issue (e.g. "feature/ISS-131"). */
  branchNameFor(issue: Issue): string;
  /** Per-repo docker worker image (e.g. node vs flutter); undefined → backend default. */
  readonly workerImage?: string;
  /** Static verification commands (lint/typecheck/analyze) — no app execution. */
  readonly verifyCommands: string[];
  /** Hook run once after cloning (e.g. `npm ci`) to install deps. */
  readonly afterClone?: string;
  /** Authenticated clone URL (embeds a token — never log verbatim). */
  cloneUrl(): string;
  listOpenPullRequests(): Promise<PullRequest[]>;
  findPullRequestByBranch(branch: string): Promise<PullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  fetchPullRequestComments(pr: PullRequest, since?: string): Promise<PullRequestComment[]>;
  createPullRequestComment(pr: PullRequest, body: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /** Re-fetch a single PR to learn its current (e.g. merged) state. null if gone. */
  refreshPullRequest(number: number): Promise<PullRequest | null>;
}

// ─────────────────────────────────────────────────────────────── axis 3: agent

export type AgentStage = 'planning' | 'implementation' | 'review';

export interface AgentRunOptions {
  stage: AgentStage;
  /** Rendered workflow instructions written into the workspace before the run. */
  workflow: string;
  /** The turn message: kickoff prompt, or an approval/feedback signal. */
  prompt: string;
  /** Keep session memory across dispatches (provider's "continue" semantics). */
  continueSession: boolean;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  turnTimeoutMs?: number;
  allowedTools?: string[];
  signal?: AbortSignal;
}

export interface AgentRunResult {
  ok: boolean;
  /** Accumulated USD cost parsed from the agent's output stream. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Set when the run failed in a way the orchestrator must react to.
   * - `login_required`: no/invalid credential — a setup error (NOT failover-eligible).
   * - `auth`: authenticated then the session/account ended mid-run (failover-eligible).
   * - `rate_limit` / `budget`: out of capacity (failover-eligible).
   * - `timeout` / `crashed`: transient/bug — retried on the same agent.
   */
  error?: 'timeout' | 'auth' | 'login_required' | 'crashed' | 'budget' | 'rate_limit';
  exitCode: number | null;
}

/**
 * Orchestrator-facing agent interface. Provider-neutral on purpose: a generic
 * implementation composes a provider × transport (see ../agent/types.ts) and
 * aggregates the normalized event stream into an AgentRunResult.
 */
export interface AgentAdapter {
  readonly kind: string;
  readonly primary: boolean;
  run(workspace: WorkspaceHandle, issue: Issue, opts: AgentRunOptions): Promise<AgentRunResult>;
}

// ─────────────────────────────────────────────────────────── axis 4: workspace

export interface WorkspaceHandle {
  /** = issue identifier; also the container name (`corral-<identifier>`). */
  readonly id: string;
  /** Path the agent runs in (host path for local, container path for docker). */
  readonly workdir: string;
  readonly backend: 'docker' | 'local';
}

/**
 * Abstracts "read/write files inside the workspace" so orchestrator logic never
 * knows whether it's talking to a docker container (via `docker exec`) or local fs.
 */
export interface WorkspaceIO {
  readFile(handle: WorkspaceHandle, path: string): Promise<string | null>;
  writeFile(handle: WorkspaceHandle, path: string, content: string): Promise<void>;
  exists(handle: WorkspaceHandle, path: string): Promise<boolean>;
  list(handle: WorkspaceHandle, dir: string): Promise<string[]>;
  /** Unified diff from `baseCommit` to HEAD. `subdir` scopes it to one repo clone
   * (relative to the workspace root); omit/'.' for the root itself. */
  getDiff(handle: WorkspaceHandle, baseCommit: string, subdir?: string): Promise<string>;
  /** Run a shell command inside the workspace (hooks, git). */
  exec(handle: WorkspaceHandle, command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** One repository to clone into the workspace, under its own `<key>` subdirectory. */
export interface WorkspaceRepoSpec {
  key: string;
  /** Authenticated clone URL (embeds a token — never log verbatim). */
  cloneUrl: string;
  baseBranch: string;
}

export interface CreateWorkspaceInput {
  identifier: string;
  /** Repos cloned side by side, each into `<workspace>/<key>`. */
  repos: WorkspaceRepoSpec[];
  /** Worker image override (docker backend). */
  image?: string;
  /** Extra read-only repos to clone alongside (e.g. a conventions/skills repo). */
  extraRepos?: Array<{ cloneUrl: string; path: string }>;
}

export interface WorkspaceAdapter {
  readonly kind: 'docker' | 'local';
  create(input: CreateWorkspaceInput): Promise<WorkspaceHandle>;
  /** Reattach to an existing workspace after a restart (recovery). null if gone. */
  reattach(identifier: string): Promise<WorkspaceHandle | null>;
  cleanup(handle: WorkspaceHandle): Promise<void>;
  io: WorkspaceIO;
}

// ───────────────────────────────────────────────────────────── axis 5: channel

/**
 * The human approval/feedback surface. Implemented by a web dashboard (default)
 * or Slack. The only human touch-points: plan approval (with option selection),
 * review approval, PR-fix-plan approval, and ad-hoc questions.
 */
export type ApprovalKind = 'plan' | 'fix_plan' | 'review' | 'pr_plan' | 'question';

export interface ApprovalRequest {
  identifier: string;
  kind: ApprovalKind;
  /** Short heading line (e.g. issue title). */
  title: string;
  /** Markdown body (the plan / review document). */
  body: string;
  /** Selectable options (a plan picker renders these). */
  options?: string[];
}

/** Extra input the user supplies when approving (chosen option + free-text notes). */
export interface ApprovalDetail {
  selection?: string;
  notes?: string;
}

export interface ChannelAdapter {
  readonly kind: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Post an approval request; returns an approvalId. */
  sendApproval(req: ApprovalRequest): Promise<string>;
  /** Plain notification / reply to the user (no approval semantics). */
  notify(identifier: string, text: string): Promise<void>;
  /** Provide a unified diff for the issue (web shows inline / slack uploads). */
  uploadDiff(identifier: string, filename: string, diff: string): Promise<void>;
  /** Approval granted (optionally with a selected option + notes). */
  onApprove(cb: (approvalId: string, detail?: ApprovalDetail) => void): void;
  /** Revision requested with feedback text. */
  onFeedback(cb: (approvalId: string, text: string) => void): void;
}

// ──────────────────────────────────────────────────────────── orchestrator phase

/** Fine-grained internal phase, persisted for restart recovery. */
export type IssuePhase =
  | 'initial'
  | 'plan_reviewing'
  | 'plan_sent'
  | 'pr_plan_sent'
  | 'implementing'
  | 'question_sent'
  | 'review_sent'
  | 'review_fixing'
  | 'pr_fixing'
  | 'pr_open'
  | 'auth_error_waiting';

/**
 * Phases where the poller must NOT dispatch — either waiting on a human (`*_sent`)
 * or on an external event (`pr_open` waits for PR comments/merge via the repo poller).
 */
export const WAITING_PHASES: ReadonlySet<IssuePhase> = new Set([
  'plan_sent',
  'pr_plan_sent',
  'review_sent',
  'question_sent',
  'pr_open',
  'auth_error_waiting',
]);

/**
 * Unattended phases (no human gate, no external wake event) that a restart can
 * leave mid-run. On recovery these are marked retryable rather than auto-redispatched.
 */
export const RESUMABLE_PHASES: ReadonlySet<IssuePhase> = new Set(['implementing', 'review_fixing']);
