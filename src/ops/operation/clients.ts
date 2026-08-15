/**
 * The providers the operational AI can ask, built from the same agent settings the
 * development AI uses (D24 — one place to configure a provider, not two).
 *
 * Only `api` entries make it through. The `cli` transport spawns a coding agent that
 * reads files and runs commands; there is no way to ask it one question and get one JSON
 * object back. So a core configured for CLI only can run pipelines' triggers and inputs
 * but not their model step — and it should say that plainly rather than appear to work.
 */
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
 */
export async function opsChatClients(agent: AgentConfig, credentials: CredentialStore): Promise<ChatClient[]> {
  const clients: ChatClient[] = [];
  const seen = new Set<AgentProviderId>();

  for (const entry of [agent, ...agent.fallbacks]) {
    if (entry.transport !== 'api' || !entry.credential) continue;
    if (seen.has(entry.provider)) continue; // the first entry for a provider wins
    const key = await credentials.get(entry.credential as CredentialRef).catch(() => null);
    if (!key) {
      logger.warn(`ops: no key for ${entry.provider} (${entry.credential.service}:${entry.credential.account}) — skipping`);
      continue;
    }
    seen.add(entry.provider);
    clients.push(chatClient(entry.provider, key));
  }

  return clients;
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
