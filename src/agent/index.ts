/** Agent axis. Transports are registered per provider×transport cell (keyed
 * `${provider}:${transport}`); createAgent wraps the selected transport in a
 * provider-neutral GenericAgent.
 *
 * The cli transports spawn the user's installed CLI (BYOK via API key / subscription).
 * The raw-HTTP `api` transports run the shared agentic loop (api-loop.ts) directly —
 * claude:api, gemini:api, and gpt:api are all implemented. */
import type { AgentRoutingConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { AgentAdapter, WorkspaceIO } from '../core/types.js';
import { ClaudeApiTransport } from './claude-api.js';
import { ClaudeCliTransport } from './claude-cli.js';
import { CodexCliTransport } from './codex-cli.js';
import { GeminiApiTransport } from './google-api.js';
import { GeminiCliTransport } from './gemini-cli.js';
import { GenericAgent } from './generic.js';
import { OpenAiApiTransport } from './openai-api.js';
import type { AgentTransport } from './types.js';

export interface AgentTransportCtx {
  /** Resolved API key for BYOK (null when relying on the CLI's own login). */
  apiKey: string | null;
  /** Resolved subscription OAuth token (from `claude setup-token`), injected as
   *  CLAUDE_CODE_OAUTH_TOKEN — authenticates the cli in docker with no API key. */
  oauthToken: string | null;
  /** Workspace IO the agent uses to write the workflow guide. */
  io: WorkspaceIO;
}

export const agentTransports = new Registry<{ kind: string }, AgentTransport, AgentTransportCtx>('agent transport');

agentTransports.register('claude:cli', (_config, ctx) => new ClaudeCliTransport(ctx.apiKey, ctx.oauthToken));
agentTransports.register('claude:api', (_config, ctx) => new ClaudeApiTransport(ctx.apiKey));
agentTransports.register('gemini:cli', (_config, ctx) => new GeminiCliTransport(ctx.apiKey));
agentTransports.register('gemini:api', (_config, ctx) => new GeminiApiTransport(ctx.apiKey));
// gpt docker auth reuses the oauth slot: oauthToken carries the base64 ~/.codex/auth.json.
agentTransports.register('gpt:cli', (_config, ctx) => new CodexCliTransport(ctx.apiKey, ctx.oauthToken));
agentTransports.register('gpt:api', (_config, ctx) => new OpenAiApiTransport(ctx.apiKey));

export function createAgent(config: AgentRoutingConfig, ctx: AgentTransportCtx): AgentAdapter {
  const transport = agentTransports.create({ kind: `${config.provider}:${config.transport}` }, ctx);
  // Effort reaches only the transports that name it on the wire. Where it does not, the
  // caller is told at startup rather than the setting disappearing (CRL-131).
  const efforts = transportHonoursEffort(config) ? config.effort : undefined;
  return new GenericAgent(transport, { primary: true, models: config.models, efforts, io: ctx.io });
}

/**
 * Whether this provider × transport pair does anything with `effort`.
 *
 * Only the claude CLI takes it (`--effort low|medium|high|xhigh|max`, measured). codex may
 * accept `-c model_reasoning_effort=`, but that could not be verified here — the local codex
 * refuses its own default model — so it is left out rather than mapped on a guess. gemini's
 * CLI has no equivalent, and the API transports reach the model directly with extended
 * thinking off, which is a different setting with a different unit.
 */
export function transportHonoursEffort(config: Pick<AgentRoutingConfig, 'provider' | 'transport'>): boolean {
  return config.provider === 'claude' && config.transport === 'cli';
}
