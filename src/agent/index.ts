/** Agent axis. Transports are registered per provider×transport cell (keyed
 * `${provider}:${transport}`); createAgent wraps the selected transport in a
 * provider-neutral GenericAgent.
 *
 * The working path is the CLI transport (spawns the user's installed CLI, BYOK via
 * API key). The raw-HTTP `api` transport is a stub (see claude-api.ts). */
import type { AgentConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { AgentAdapter, WorkspaceIO } from '../core/types.js';
import { ClaudeApiTransport } from './claude-api.js';
import { ClaudeCliTransport } from './claude-cli.js';
import { GenericAgent } from './generic.js';
import type { AgentTransport } from './types.js';

export interface AgentTransportCtx {
  /** Resolved API key for BYOK (null when relying on the CLI's own login). */
  apiKey: string | null;
  /** Workspace IO the agent uses to write the workflow guide. */
  io: WorkspaceIO;
}

export const agentTransports = new Registry<{ kind: string }, AgentTransport, AgentTransportCtx>('agent transport');

agentTransports.register('claude:cli', (_config, ctx) => new ClaudeCliTransport(ctx.apiKey));
agentTransports.register('claude:api', (_config, ctx) => new ClaudeApiTransport(ctx.apiKey));
// gemini:cli, gpt:cli, … are added in a later milestone.

export function createAgent(config: AgentConfig, ctx: AgentTransportCtx): AgentAdapter {
  const transport = agentTransports.create({ kind: `${config.provider}:${config.transport}` }, ctx);
  return new GenericAgent(transport, { primary: true, models: config.models, io: ctx.io });
}
