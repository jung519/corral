/** Shapes mirrored from the control-plane API (src/server/dashboard.ts). */

export interface IssueRuntime {
  identifier: string;
  repoKey: string;
  phase: string;
  title?: string;
  url?: string;
  pr?: { number: number; branch: string; url?: string };
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
