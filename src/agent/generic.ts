/** Provider-neutral AgentAdapter: maps an orchestrator run into a transport turn,
 * streams the transport's normalized events to the event bus (live timeline), and
 * aggregates them into an AgentRunResult.
 *
 * This aggregation is net-new logic (NOT lifted from upstream) and is exercised by
 * tests with a fake transport, so it works before any real transport runs. */
import { bus } from '../core/events.js';
import type { AgentAdapter, AgentRunOptions, AgentRunResult, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import type { AgentTransport, AgentTurnSpec, StageModels } from './types.js';

export interface GenericAgentOptions {
  primary: boolean;
  /** Per-stage model mapping; opts.model overrides. */
  models: StageModels;
  /** Workspace file IO, used by the transport to write the workflow guide. */
  io: WorkspaceIO;
}

export class GenericAgent implements AgentAdapter {
  readonly kind: string;
  readonly primary: boolean;

  constructor(
    private readonly transport: AgentTransport,
    private readonly options: GenericAgentOptions,
  ) {
    this.kind = transport.provider;
    this.primary = options.primary;
  }

  async run(workspace: WorkspaceHandle, _issue: Issue, opts: AgentRunOptions): Promise<AgentRunResult> {
    const spec: AgentTurnSpec = {
      handle: workspace,
      io: this.options.io,
      prompt: opts.prompt,
      workflow: opts.workflow,
      model: opts.model ?? this.options.models[opts.stage],
      continueSession: opts.continueSession,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      turnTimeoutMs: opts.turnTimeoutMs,
      allowedTools: opts.allowedTools,
      signal: opts.signal,
    };

    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let error: AgentRunResult['error'];
    let exitCode: number | null = null;

    await this.transport.run(spec, (event) => {
      switch (event.type) {
        case 'usage':
          costUsd = event.costUsd;
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
          break;
        case 'error':
          error = event.error;
          break;
        case 'done':
          exitCode = event.exitCode;
          break;
        case 'text':
          bus.emitEvent({ identifier: workspace.id, kind: 'activity', label: `💬 ${event.text}`, data: { stage: opts.stage } });
          break;
        case 'tool_use':
          bus.emitEvent({ identifier: workspace.id, kind: 'activity', label: `🔧 ${event.name}`, data: { stage: opts.stage } });
          break;
      }
    });

    const ok = !error && (exitCode === 0 || exitCode === null);
    return { ok, costUsd, inputTokens, outputTokens, error, exitCode };
  }
}
