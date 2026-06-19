/** Agent axis. Transports are registered per provider×transport cell (keyed
 * `${provider}:${transport}`); createAgent wraps the selected transport in a
 * provider-neutral GenericAgent. */
import type { AgentConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { AgentAdapter } from '../core/types.js';
import { ClaudeApiTransport } from './claude-api.js';
import { GenericAgent } from './generic.js';
import type { AgentTransport } from './types.js';

export interface AgentTransportCtx {
  /** Resolved API key for `api` transport (null for `cli`). */
  apiKey: string | null;
}

export const agentTransports = new Registry<{ kind: string }, AgentTransport, AgentTransportCtx>('agent transport');

agentTransports.register('claude:api', (_config, ctx) => new ClaudeApiTransport(ctx.apiKey));
// claude:cli, gemini:api, gpt:api … are lifted/added in S2+.

export function createAgent(config: AgentConfig, ctx: AgentTransportCtx): AgentAdapter {
  const transport = agentTransports.create({ kind: `${config.provider}:${config.transport}` }, ctx);
  return new GenericAgent(transport, { primary: true, models: config.models });
}
