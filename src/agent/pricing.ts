/**
 * Approximate BYOK token pricing for the `*:api` transports, used to estimate run cost and
 * enforce the `maxBudgetUsd` cap (the cli transports report their own / subscription cost).
 *
 * Prices are USD per 1M tokens and DRIFT — treat them as a budgeting guardrail, not a
 * billing source of truth. Matching is by substring so an alias (`opus`, `flash`) and a
 * concrete id (`claude-opus-4-1`, `gemini-2.5-flash`) both resolve. Update as vendors change.
 */
import type { AgentProviderId } from './types.js';

export interface TokenPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

interface Rule {
  match: string;
  price: TokenPrice;
}

// Ordered most-specific first (flash-lite before flash, gpt-5-mini before gpt-5).
const TABLE: Record<AgentProviderId, { rules: Rule[]; fallback: TokenPrice }> = {
  claude: {
    rules: [
      { match: 'opus', price: { input: 15, output: 75 } },
      { match: 'sonnet', price: { input: 3, output: 15 } },
      { match: 'haiku', price: { input: 0.8, output: 4 } },
    ],
    fallback: { input: 3, output: 15 },
  },
  gemini: {
    rules: [
      { match: 'flash-lite', price: { input: 0.1, output: 0.4 } },
      { match: 'flash', price: { input: 0.3, output: 2.5 } },
      { match: 'pro', price: { input: 1.25, output: 10 } },
    ],
    fallback: { input: 0.3, output: 2.5 },
  },
  gpt: {
    rules: [
      { match: 'gpt-5-mini', price: { input: 0.25, output: 2 } },
      { match: 'gpt-5', price: { input: 1.25, output: 10 } },
      { match: 'o4-mini', price: { input: 1.1, output: 4.4 } },
    ],
    fallback: { input: 1.25, output: 10 },
  },
};

/** USD cost of a turn for the given provider/model and token counts. */
export function priceFor(provider: AgentProviderId, model: string | undefined, inputTokens: number, outputTokens: number): number {
  const table = TABLE[provider];
  const m = (model ?? '').toLowerCase();
  const price = table.rules.find((r) => m.includes(r.match))?.price ?? table.fallback;
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}
