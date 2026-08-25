/**
 * Approximate BYOK token pricing, used to estimate run cost and enforce the `maxBudgetUsd`
 * cap and the daily `limits.daily_cost_usd` ceiling.
 *
 * Used by the `*:api` transports and by two of the three CLIs: only `claude` reports a cost
 * of its own, and it wins where it does — it knows the account's terms. `codex` and `gemini`
 * report tokens and no money, and counting those turns as free is what made a day's total
 * silently omit whatever the operational pillar spent (CRL-86).
 *
 * Prices are USD per 1M tokens and DRIFT — treat them as a budgeting guardrail, not a
 * billing source of truth. Matching is by substring so an alias (`opus`, `flash`) and a
 * concrete id (`claude-opus-4-1`, `gemini-2.5-flash`) both resolve. Update as vendors change.
 */
import type { AgentProviderId } from './types.js';

export interface TokenPrice {
  /** USD per 1M fresh input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * What cached input costs, as a multiple of the fresh input price — per vendor, because
 * they differ by a lot.
 *
 * Pricing every input token at the fresh rate is what makes an estimate useless here: a
 * measured planning turn of 1,603,499 input tokens actually cost $1.97, and the flat rate
 * calls it $24 on Opus. An agent loop re-sends the whole conversation on every tool call,
 * so from the second call on the input is nearly all cache reads (CRL-86).
 *
 * Anthropic charges a premium to write the cache and a tenth to read it. OpenAI's automatic
 * caching is half price with nothing extra to write. Gemini's implicit discount sits between
 * the two. These drift like the prices above them.
 */
const CACHE: Record<AgentProviderId, { read: number; write: number }> = {
  claude: { read: 0.1, write: 1.25 },
  gpt: { read: 0.5, write: 1 },
  gemini: { read: 0.25, write: 1 },
};

/**
 * How much of the input was cache. The rest — the remainder against the total — is fresh,
 * so there is deliberately no `fresh` field to disagree with the total.
 */
export interface InputBreakdown {
  /** Tokens written into the prompt cache. */
  cacheWrite?: number;
  /** Tokens served from the prompt cache. */
  cacheRead?: number;
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

/**
 * USD cost of a turn for the given provider/model and token counts.
 *
 * `inputTokens` is the total — the same number the daily ceiling counts (CRL-58) — and
 * `breakdown` says how much of it was cache. Without a breakdown every token is priced as
 * fresh input, which overstates a cache-heavy turn by around an order of magnitude; that is
 * the safe direction for a guardrail, but it is why the breakdown is worth carrying.
 */
export function priceFor(
  provider: AgentProviderId,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  breakdown?: InputBreakdown,
): number {
  const table = TABLE[provider];
  const m = (model ?? '').toLowerCase();
  const price = table.rules.find((r) => m.includes(r.match))?.price ?? table.fallback;

  const cache = CACHE[provider];
  const cacheWrite = breakdown?.cacheWrite ?? 0;
  const cacheRead = breakdown?.cacheRead ?? 0;
  // Whatever the breakdown does not account for is fresh — including the whole total when
  // there is no breakdown at all.
  const fresh = Math.max(0, inputTokens - cacheWrite - cacheRead);

  const input = (fresh + cacheWrite * cache.write + cacheRead * cache.read) / 1e6;
  return input * price.input + (outputTokens / 1e6) * price.output;
}
