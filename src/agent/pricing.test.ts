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
