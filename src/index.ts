/**
 * Corral public surface (S1 — skeleton).
 *
 * Exposes the 5-axis adapter interfaces, the registry, the net-new agent and
 * credential boundaries, and the config schema. The orchestrator core is lifted
 * from upstream in S2 (see docs/development-plan.md §1.3) — there is no runnable
 * entrypoint yet.
 */
export * from './core/types.js';
export * from './core/registry.js';
export { ConcurrencyLimiter } from './core/concurrency-limiter.js';
export { logger, makeLogger, type Logger } from './core/logger.js';
export { bus, type CorralEvent, type EventKind } from './core/events.js';
export { fetchRetry, fetchJson, HttpError, type FetchRetryOptions } from './core/fetch-retry.js';
export { IssueStateStore, type IssueRuntime, DEFAULT_STATE_DIR } from './core/issue-state.js';
export { CostTracker, type CostEntry } from './core/cost-tracker.js';
export * from './agent/types.js';
export { createAgent, agentTransports, type AgentTransportCtx } from './agent/index.js';
export { ClaudeCliTransport } from './agent/claude-cli.js';
export { ClaudeApiTransport } from './agent/claude-api.js';
export {
  renderWorkflow,
  kickoffPrompt,
  turnPrompt,
  buildSignals,
  PROMPTS,
  type Signals,
  type WorkflowContext,
} from './agent/prompt-builder.js';
export { SCRATCH, SCRATCH_DIR, WORKFLOW_FILE } from './core/paths.js';
export { ReviewOrchestrator, type ReviewResult, type RoundCostFn } from './review/orchestrator.js';
export { PlanCritiqueOrchestrator } from './review/plan-critique.js';
export { runStaticQa, type StaticQaReport } from './review/static-qa-runner.js';
export { runSemgrep, type SemgrepConfig } from './review/semgrep-runner.js';
export { reviewRoundPrompt, planCritiquePrompt } from './review/prompt.js';
export * from './credentials/types.js';
export { EnvCredentialStore } from './credentials/env-store.js';
export { FileCredentialStore } from './credentials/file-store.js';
export { LayeredCredentialStore } from './credentials/layered.js';
export * from './config/schema.js';
export { loadConfig, parseConfig } from './config/loader.js';
export { bootstrap, bootstrapFromFile, type App, type BootstrapDeps } from './bootstrap.js';
export { Orchestrator } from './orchestrator.js';
export { processAttachments } from './attachments.js';
export {
  resolveProfile,
  type ResolvedProfile,
  createTranslator,
  type Translator,
  type MessageKey,
  availableLanguages,
  resolveStackProfile,
  availableStacks,
  type StackProfile,
} from './profile/index.js';
export { trackers } from './tracker/index.js';
export { GithubIssuesTracker } from './tracker/github-issues.js';
export { TrackerPoller, type IssuesHandler } from './tracker/poller.js';
export { repositories } from './repository/index.js';
export { RepositoryRouter } from './repository/router.js';
export { RepositoryPoller, type TrackedPr, type RepoEvents } from './repository/poller.js';
export { workspaces, dockerOptionsFromConfig, type WorkspaceCtx } from './workspace/index.js';
export { run, runOrThrow, type ExecResult, type ExecOptions } from './util/exec.js';
export { channels } from './channel/index.js';
export { WebChannel, type PendingAction, type IssueDiff } from './channel/web.js';
export { DashboardServer, type DashboardDeps, type SetupInput } from './server/dashboard.js';
