/** Claude API transport — BYOK, the priority path. S1: preflight (key presence)
 * is real; the turn execution + stream normalization is lifted in S2. */
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
    return { ok: true };
  }

  // eslint-disable-next-line require-yield
  async *run(_spec: AgentTurnSpec): AsyncIterable<AgentEvent> {
    notImplemented('claude:api transport run');
  }
}
