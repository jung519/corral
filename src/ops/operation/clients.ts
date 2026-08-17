/**
 * The providers the operational AI can ask, built from the same agent settings the
 * development AI uses (D24 — one place to configure a provider, not two).
 *
 * Two ways to ask, from one set of settings.
 *
 * `opsChatClients` builds the API side — one HTTP call, which is what a step running
 * thousands of times a day wants. `opsCliTransports` builds the other, for a core whose
 * only login is a CLI's: there the answer comes back as a file the agent writes
 * (`cli-turn.ts`). Neither knows about pipelines; both are just "who can be asked".
 */
import { agentTransports } from '../../agent/index.js';
import type { AgentTransport } from '../../agent/types.js';
import { AnthropicChatClient } from '../../agent/claude-api.js';
import { GeminiChatClient } from '../../agent/google-api.js';
import { OpenAiChatClient } from '../../agent/openai-api.js';
import type { ChatClient } from '../../agent/api-loop.js';
import type { AgentProviderId } from '../../agent/types.js';
import type { AgentConfig } from '../../config/schema.js';
import type { CredentialRef, CredentialStore } from '../../credentials/types.js';
import { logger } from '../../core/logger.js';

function chatClient(provider: AgentProviderId, apiKey: string): ChatClient {
  switch (provider) {
    case 'claude':
      return new AnthropicChatClient(apiKey);
    case 'gemini':
      return new GeminiChatClient(apiKey);
    case 'gpt':
      return new OpenAiChatClient(apiKey);
  }
}

/**
 * The configured providers, in preference order: the primary first, then its fallbacks.
 *
 * Entries without a usable key are dropped with a warning rather than kept as clients
 * that fail on every call — a provider that cannot authenticate is not a fallback, it's
 * an extra failure between the pipeline and an answer.
 *
 * Two entries for the SAME provider are kept when they point at different credentials.
 * That is the multi-account case the development side supports too (`bootstrap.ts` labels
 * them "#2", "#3"): one account's quota runs out and the next one carries on. Collapsing
 * them by provider would throw that away.
 */
export async function opsChatClients(agent: AgentConfig, credentials: CredentialStore): Promise<ChatClient[]> {
  const clients: ChatClient[] = [];
  const seen = new Set<string>();

  for (const entry of [agent, ...agent.fallbacks]) {
    if (entry.transport !== 'api' || !entry.credential) continue;
    const ref = entry.credential as CredentialRef;
    const identity = `${entry.provider}:${ref.service}:${ref.account}`;
    if (seen.has(identity)) continue; // genuinely the same account twice
    const key = await credentials.get(ref).catch(() => null);
    if (!key) {
      logger.warn(`ops: no key for ${entry.provider} (${ref.service}:${ref.account}) — skipping`);
      continue;
    }
    seen.add(identity);
    clients.push(chatClient(entry.provider, key));
  }

  return clients;
}

/**
 * Which CLIs can be run with no tools at all.
 *
 * Measured, not assumed (CRL-43). `claude --tools ""` leaves the agent unable to run a
 * command or write a file. codex was tried and cannot: under `-s read-only` the sandbox
 * blocks writes but the shell still runs, which is enough to read a secret and return it
 * inside the answer — and no feature flag turns the shell off. gemini could not be
 * measured on the machine at hand, so it stays out rather than being guessed at.
 *
 * A provider joins this set when someone has watched it refuse to run a command.
 */
const TOOLS_CAN_BE_OFF = new Set<string>(['claude']);

/**
 * The CLI transports, in the same preference order.
 *
 * A CLI entry needs no key in the config — the binary carries its own login — so unlike
 * the API side nothing is dropped for want of a credential. What it does need is a
 * transport instance, and those come from the same registry the development AI uses.
 *
 * `io` is required by the registry's context but never reached: the operational runner
 * passes an empty `workflow`, and writing that guide is the only thing that touches it.
 */
export async function opsCliTransports(agent: AgentConfig, credentials: CredentialStore): Promise<AgentTransport[]> {
  const transports: AgentTransport[] = [];
  const seen = new Set<string>();

  for (const entry of [agent, ...agent.fallbacks]) {
    if (entry.transport !== 'cli') continue;
    if (!TOOLS_CAN_BE_OFF.has(entry.provider)) {
      logger.warn(
        `ops: ${entry.provider} cli cannot be run without tools, so a pipeline's prompt — a queue message and an API response — would reach an agent that can act on it. Not offered (CRL-43).`,
      );
      continue;
    }
    if (seen.has(entry.provider)) continue; // one login per provider, unlike API keys
    seen.add(entry.provider);
    const apiKey = entry.credential ? await credentials.get(entry.credential as CredentialRef).catch(() => null) : null;
    const oauthToken = entry.oauth_credential
      ? await credentials.get(entry.oauth_credential as CredentialRef).catch(() => null)
      : null;
    try {
      transports.push(
        agentTransports.create({ kind: `${entry.provider}:cli` }, { apiKey, oauthToken, io: undefined as never }),
      );
    } catch (err) {
      logger.warn(`ops: no cli transport for ${entry.provider} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return transports;
}

/**
 * The providers a pipeline may name, with the models configured for each.
 *
 * Same filter as the runners: an api entry with a key, or any cli entry. The point is to
 * offer only what can answer — without this the editor would list every provider the
 * schema allows and let someone pick one this core cannot ask.
 */
export function opsUsableAgents(agent: AgentConfig): Array<{ provider: string; models: string[]; defaultModel?: string }> {
  const byProvider = new Map<string, { provider: string; models: string[]; defaultModel?: string }>();
  for (const entry of [agent, ...agent.fallbacks]) {
    // An API entry needs a key, because without one there is nothing to authenticate with.
    // A CLI entry carries its own login but must be runnable with no tools — the editor
    // must not offer a provider a pipeline cannot safely be asked on (CRL-43).
    if (entry.transport === 'api' ? !entry.credential : !TOOLS_CAN_BE_OFF.has(entry.provider)) continue;
    const found = byProvider.get(entry.provider) ?? { provider: entry.provider, models: [] };
    for (const m of [entry.models.planning, entry.models.implementation, entry.models.review]) {
      if (m && !found.models.includes(m)) found.models.push(m);
    }
    found.defaultModel ??= entry.models.implementation ?? entry.models.planning;
    byProvider.set(entry.provider, found);
  }
  return [...byProvider.values()];
}

/** Default model per provider, taken from the same config. Pipelines may still name one. */
export function opsModelFor(agent: AgentConfig): (provider: AgentProviderId) => string | undefined {
  const byProvider = new Map<AgentProviderId, string | undefined>();
  for (const entry of [agent, ...agent.fallbacks]) {
    if (byProvider.has(entry.provider)) continue;
    // `implementation` is the everyday workhorse model — the sensible default for a
    // short classification turn, where the planning/review models would be overkill.
    byProvider.set(entry.provider, entry.models.implementation ?? entry.models.planning);
  }
  return (provider) => byProvider.get(provider);
}
