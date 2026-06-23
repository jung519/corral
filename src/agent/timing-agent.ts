/**
 * Decorates an AgentAdapter to measure how long each run takes, reporting the elapsed
 * ms per issue (keyed by workspace.id) to a sink. The orchestrator, plan critique, and
 * review all call the same shared adapter, so wrapping it once captures every agent
 * turn — that sum is the issue's real "AI working" time (vs total wall clock).
 */
import type { AgentAdapter, AgentRunOptions, AgentRunResult, Issue, WorkspaceHandle } from '../core/types.js';

export class TimingAgent implements AgentAdapter {
  readonly kind: string;
  readonly primary: boolean;

  constructor(
    private readonly inner: AgentAdapter,
    /** Called after every run with the issue id and how long the turn took. */
    private readonly onElapsed: (issueId: string, ms: number) => void,
  ) {
    this.kind = inner.kind;
    this.primary = inner.primary;
  }

  async run(workspace: WorkspaceHandle, issue: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    const t0 = Date.now();
    try {
      return await this.inner.run(workspace, issue, opts);
    } finally {
      this.onElapsed(workspace.id, Date.now() - t0);
    }
  }
}
