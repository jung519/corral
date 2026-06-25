/** Shapes mirrored from the control-plane (src/ipc-host.ts). */

export interface IssuePr {
  repoKey: string;
  number: number;
  branch: string;
  url?: string;
}

export interface IssueRuntime {
  identifier: string;
  repoKey: string;
  phase: string;
  title?: string;
  url?: string;
  /** One PR per repo the issue changed. */
  prs?: IssuePr[];
  stuck?: boolean;
  cost: number;
}

export interface PendingAction {
  id: string;
  identifier: string;
  kind: string;
  title: string;
  bodyHtml: string;
  options?: string[];
  createdAt: number;
}

export interface CorralEvent {
  ts: number;
  identifier: string;
  kind: string;
  label: string;
  phase?: string;
}

export interface StateResponse {
  issues: IssueRuntime[];
  pending: PendingAction[];
  events: CorralEvent[];
}

export interface Candidate {
  identifier: string;
  title: string;
  state: string;
  repoKey?: string;
  inFlight: boolean;
}

export interface CommandResult {
  ok: boolean;
  merged?: boolean;
  message?: string;
}

/** Mirrors HistoryRecord in src/core/issue-history.ts. */
export interface HistoryRecord {
  v: number;
  identifier: string;
  title?: string;
  url?: string;
  trackerKind: string;
  repoKeys: string[];
  backend: 'local' | 'docker';
  outcome: 'completed' | 'removed' | 'failed';
  prs: { repoKey: string; number: number; url?: string; merged?: boolean }[];
  startedAt: number;
  endedAt: number;
  wallMs: number;
  agentActiveMs: number;
  humanWaitMs: number;
  setupMs: number;
  dispatches: number;
  phases: { phase: string; at: number; durationMs: number }[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  models: { planning: string; implementation: string; review: string };
  agentProvider: string;
  failoverUsed?: boolean;
}
