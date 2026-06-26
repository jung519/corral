/**
 * Routes each turn to the agent configured for its stage (plan / build / review), so
 * different providers can own different stages. Wrapping the shared adapter keeps the
 * orchestrator unchanged — it still calls one `agent.run(..., {stage})`.
 *
 * SESSION SAFETY: a CLI session (claude --continue, codex resume, …) belongs to ONE
 * provider; a different provider can't resume it. So when the stage's agent differs
 * from the agent that ran the previous turn for this issue, we force a fresh session
 * (continueSession=false). The cross-stage handoff then rides on files (the plan,
 * the diff, the review) — which the workflow already writes — not session memory.
 */
import type { AgentAdapter, AgentRunOptions, AgentRunResult, AgentStage, Issue, WorkspaceHandle } from '../core/types.js';

export class StageRoutingAgent implements AgentAdapter {
  readonly kind: string;
  readonly primary = true;
  /** Last agent that ran for an issue (workspace.id) — to detect provider switches. */
  private readonly lastAgent = new Map<string, AgentAdapter>();

  constructor(private readonly byStage: Record<AgentStage, AgentAdapter>) {
    const kinds = [byStage.planning, byStage.implementation, byStage.review].map((a) => a.kind);
    this.kind = [...new Set(kinds)].join(' / ');
  }

  async run(workspace: WorkspaceHandle, issue: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    const agent = this.byStage[opts.stage] ?? this.byStage.planning;
    const continueSession = opts.continueSession && this.lastAgent.get(workspace.id) === agent;
    this.lastAgent.set(workspace.id, agent);
    return agent.run(workspace, issue, { ...opts, continueSession });
  }
}
