/** Provider-neutral AgentAdapter: maps an orchestrator run into a transport turn
 * and aggregates the normalized event stream into an AgentRunResult.
 *
 * This aggregation is net-new logic (NOT lifted from upstream) and is exercised by
 * tests with a fake transport, so it works before any real transport exists. */
import type { AgentAdapter, AgentRunOptions, AgentRunResult, Issue, WorkspaceHandle } from '../core/types.js';
import type { AgentTransport, AgentTurnSpec, StageModels } from './types.js';

export interface GenericAgentOptions {
  primary: boolean;
  /** Per-stage model mapping; opts.model overrides. */
  models: StageModels;
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
      cwd: workspace.workdir,
      prompt: opts.prompt,
      model: opts.model ?? this.options.models[opts.stage],
      continueSession: opts.continueSession,
      maxTurns: opts.maxTurns,
      turnTimeoutMs: opts.turnTimeoutMs,
      allowedTools: opts.allowedTools,
      signal: opts.signal,
    };

    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let error: AgentRunResult['error'];
    let exitCode: number | null = null;

    for await (const ev of this.transport.run(spec)) {
      switch (ev.type) {
        case 'usage':
          costUsd += ev.costUsd;
          inputTokens += ev.inputTokens;
          outputTokens += ev.outputTokens;
          break;
        case 'error':
          error = ev.error;
          break;
        case 'done':
          exitCode = ev.exitCode;
          break;
        case 'text':
        case 'tool_use':
          break;
      }
    }

    const ok = !error && (exitCode === 0 || exitCode === null);
    return { ok, costUsd, inputTokens, outputTokens, error, exitCode };
  }
}
