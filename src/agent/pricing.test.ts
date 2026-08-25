import { describe, expect, it } from 'vitest';
import { priceFor } from './pricing.js';

describe('priceFor', () => {
  it('prices 1M in + 1M out for a known model', () => {
    expect(priceFor('claude', 'opus', 1_000_000, 1_000_000)).toBeCloseTo(90); // 15 + 75
  });

  it('resolves both aliases and concrete ids by substring', () => {
    expect(priceFor('claude', 'claude-opus-4-1', 1_000_000, 0)).toBeCloseTo(15);
    expect(priceFor('gemini', 'gemini-2.5-flash', 1_000_000, 0)).toBeCloseTo(0.3);
  });

  it('matches the most specific rule first', () => {
    // flash-lite must not fall through to flash; gpt-5-mini must not fall through to gpt-5.
    expect(priceFor('gemini', 'flash-lite', 1_000_000, 0)).toBeCloseTo(0.1);
    expect(priceFor('gpt', 'gpt-5-mini', 0, 1_000_000)).toBeCloseTo(2);
  });

  it('falls back when the model is unknown', () => {
    expect(priceFor('gpt', 'mystery-model', 1_000_000, 0)).toBeCloseTo(1.25);
  });
});

/**
 * An agent loop re-sends the whole conversation on every tool call, so from the second call
 * on the input is nearly all cache reads. Pricing all of it as fresh is what made the
 * estimate useless (CRL-86).
 */
describe('cached input', () => {
  it('prices a cache read at a tenth on claude, a write above full', () => {
    expect(priceFor('claude', 'sonnet', 1_000_000, 0, { cacheRead: 1_000_000 })).toBeCloseTo(0.3);
    expect(priceFor('claude', 'sonnet', 1_000_000, 0, { cacheWrite: 1_000_000 })).toBeCloseTo(3.75);
  });

  it("uses each vendor's own multiple rather than one number for all three", () => {
    // Anthropic reads at a tenth; OpenAI's automatic caching is half; Gemini's sits between.
    // Charging every vendor Anthropic's discount would understate two of the three.
    expect(priceFor('gpt', 'gpt-5', 1_000_000, 0, { cacheRead: 1_000_000 })).toBeCloseTo(0.625);
    expect(priceFor('gemini', 'pro', 1_000_000, 0, { cacheRead: 1_000_000 })).toBeCloseTo(0.3125);
  });

  it('treats whatever the breakdown does not name as fresh', () => {
    // 200k fresh + 800k read on sonnet: 0.2 × 3 + 0.8 × 0.3.
    expect(priceFor('claude', 'sonnet', 1_000_000, 0, { cacheRead: 800_000 })).toBeCloseTo(0.84);
  });

  it('is unchanged when there is no breakdown at all', () => {
    expect(priceFor('claude', 'sonnet', 1_000_000, 0)).toBeCloseTo(3);
  });

  it('does not go negative when the parts exceed the total', () => {
    // A vendor that ever reports the cached counts as additions rather than a subset would
    // otherwise produce a negative fresh count and an under-estimate.
    expect(priceFor('claude', 'sonnet', 100, 0, { cacheRead: 1_000, cacheWrite: 1_000 })).toBeGreaterThan(0);
  });

  /**
   * The measurement the issue was written from. One planning turn, as the claude CLI
   * reported it: 1,603,499 input tokens, 21,324 output, and a cost of $1.9683.
   *
   * Flat pricing calls the same turn $25.65 on opus — an estimate off by 13× is not a
   * budgeting tool. With the input read as cache, the estimate lands in the same order of
   * magnitude as the bill, which is all a guard rail has to do.
   */
  it('lands in the same order of magnitude as a measured turn', () => {
    const MEASURED = 1.9683;
    const input = 1_603_499;
    const flat = priceFor('claude', 'sonnet', input, 21_324);
    const cached = priceFor('claude', 'sonnet', input, 21_324, { cacheRead: input * 0.9 });

    expect(flat / MEASURED).toBeGreaterThan(2.5);
    expect(cached).toBeGreaterThan(MEASURED / 3);
    expect(cached).toBeLessThan(MEASURED * 3);
  });
});
