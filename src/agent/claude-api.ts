/**
 * Claude API transport — direct BYOK calls to the Anthropic Messages API.
 *
 * STUB. A full API transport must implement the agentic coding loop (tool-use
 * round-trips: read/write files, run commands, etc.) — essentially a coding agent
 * over raw HTTP. That is a large net-new build and is NOT lifted from upstream
 * (which delegates the loop to the CLI). Until it lands, use the `cli` transport.
 * preflight here is real so misconfiguration surfaces early.
 */
import { notImplemented } from '../core/not-implemented.js';
import type { AgentEvent, AgentTransport, AgentTurnSpec, PreflightResult } from './types.js';

export class ClaudeApiTransport implements AgentTransport {
  readonly provider = 'claude' as const;
  readonly transport = 'api' as const;

  constructor(private readonly apiKey: string | null) {}

  async preflight(): Promise<PreflightResult> {
    if (!this.apiKey) {
      return { ok: false, detail: 'missing Anthropic API key (BYOK) for claude:api transport' };
    }
    return { ok: false, detail: 'claude:api transport is not implemented yet — use transport: cli' };
  }

  async run(_spec: AgentTurnSpec, _onEvent: (event: AgentEvent) => void): Promise<void> {
    notImplemented('claude:api transport run (use transport: cli)');
  }
}
