/**
 * The ceiling in money.
 *
 * The tokens stay the figure of record — they come back from the response and are exactly
 * what was spent. But nobody budgets in tokens: "2,000,000 input tokens" answers neither
 * "can I afford to run this tonight" nor "was this issue worth it", and the operator has to
 * answer both (CRL-86). So the day carries an estimate alongside the counts, and it can be
 * the thing that stops the work.
 *
 * The estimate is only as good as `agent/pricing.ts`, which is why the questions here are
 * about honesty as much as arithmetic: what the day says when part of it could not be
 * priced at all.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, type CorralEvent } from './events.js';
import { TokenBudget, type TokenLimits } from './token-budget.js';

let dir: string;
let clock: number;
let seen: CorralEvent[];
let unsubscribe: () => void;

const NOON = new Date(2026, 7, 15, 12, 0, 0).getTime();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-cost-'));
  clock = NOON;
  seen = [];
  unsubscribe = bus.subscribe((e) => seen.push(e));
});
afterEach(() => {
  unsubscribe();
  rmSync(dir, { recursive: true, force: true });
});

const budget = (limits: TokenLimits = {}) => new TokenBudget(limits, dir, { now: () => clock });
const labels = () => seen.filter((e) => e.identifier === 'token-budget').map((e) => e.label);

describe('a ceiling in dollars', () => {
  it('stops the work on its own, with no token ceiling set at all', () => {
    const b = budget({ dailyCostUsd: 5 });
    expect(b.check().ok).toBe(true);

    b.record({ inputTokens: 10, outputTokens: 1, costUsd: 5 }, 'development');

    expect(budget({ dailyCostUsd: 5 }).check()).toMatchObject({ ok: false });
  });

  it('says which side is exhausted, in money', () => {
    budget({ dailyCostUsd: 5 }).record({ inputTokens: 10, outputTokens: 1, costUsd: 6.5 }, 'development');
    expect(budget({ dailyCostUsd: 5 }).check().reason).toBe('daily cost limit reached ($6.50/$5.00)');
  });

  it('is one ceiling with three doors — whichever runs out first shuts both pillars out', () => {
    // Money spent by the operational AI stops the development AI, exactly as tokens do.
    budget({ dailyCostUsd: 1 }).record({ inputTokens: 1, outputTokens: 0, costUsd: 1 }, 'operations');
    expect(budget({ dailyCostUsd: 1 }).check().ok).toBe(false);
  });

  it('counts as configured, so the screen shows a bar for it', () => {
    expect(budget({ dailyCostUsd: 5 }).configured).toBe(true);
    expect(budget().configured).toBe(false);
  });

  it('crosses its thresholds like the token ones do', () => {
    const b = budget({ dailyCostUsd: 10 });
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 8.5 }, 'development');

    expect(labels().some((l) => l.includes('80%'))).toBe(true);
    expect(labels().some((l) => l.includes('$8.50'))).toBe(true);
  });
});

/**
 * A price table cannot price everything. Absent is not zero — the same rule an absent
 * `criteria` block (CRL-108) and an unreadable HEAD (CRL-109) follow.
 */
describe('the part of the day that could not be priced', () => {
  it('is counted, so the figure can be labelled a floor', () => {
    const b = budget({ dailyCostUsd: 10 });
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 }, 'development');
    b.record({ inputTokens: 900, outputTokens: 90 }, 'operations');

    const s = b.snapshot();
    expect(s.costUsd).toBe(0.5);
    expect(s.unpricedCalls).toBe(1);
  });

  it('turns the announced total into a floor rather than a total', () => {
    const b = budget({ dailyCostUsd: 1 });
    b.record({ inputTokens: 100, outputTokens: 10 }, 'operations');
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 0.9 }, 'development');

    expect(labels().some((l) => l.includes('≥$0.90'))).toBe(true);
    expect(labels().some((l) => l.includes('~$0.90'))).toBe(false);
  });

  it('leaves the money off the pillar that has none rather than writing $0.00', () => {
    // `operations 100/10 $0.00` beside a real token count says that side ran for free.
    const b = budget({ dailyCostUsd: 1 });
    b.record({ inputTokens: 100, outputTokens: 10 }, 'operations');
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 0.9 }, 'development');

    expect(labels().some((l) => l.includes('operations 100/10 ·'))).toBe(true);
    expect(labels().some((l) => l.includes('$0.00'))).toBe(false);
  });

  it('reads a counter file from before pricing existed as unpriced, not as free', () => {
    // The alternative is a screen that says the morning cost $0.00, which is a statement
    // about the day rather than a gap in it.
    writeFileSync(
      join(dir, 'token-budget.json'),
      JSON.stringify({ date: '2026-08-15', inputTokens: 500_000, outputTokens: 9_000, announced: [] }),
    );
    const s = budget({ dailyCostUsd: 10 }).snapshot();

    expect(s.inputTokens).toBe(500_000);
    expect(s.costUsd).toBe(0);
    expect(s.unpricedCalls).toBeGreaterThan(0);
  });

  it('does not count a call that spent nothing as unpriced', () => {
    // A refused turn is not a gap in the measurement; it is a turn with nothing to measure.
    const b = budget({ dailyCostUsd: 10 });
    b.record({ inputTokens: 0, outputTokens: 0 }, 'development');
    expect(b.snapshot().unpricedCalls).toBe(0);
  });
});

describe('which pillar spent the money', () => {
  it('is tallied per side, alongside the tokens', () => {
    const b = budget({ dailyCostUsd: 10 });
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 0.8 }, 'development');
    b.record({ inputTokens: 30, outputTokens: 5, costUsd: 0.15 }, 'operations');
    b.record({ inputTokens: 20, outputTokens: 1, costUsd: 0.2 }, 'development');

    const s = b.snapshot();
    expect(s.byPillar.development?.costUsd).toBeCloseTo(1);
    expect(s.byPillar.operations?.costUsd).toBeCloseTo(0.15);
    expect(s.costUsd).toBeCloseTo(1.15);
  });

  it('names the money in the warning, not just the counts', () => {
    // "the development AI is eating the shared budget" has to be legible on sight (D12),
    // and by the time it matters the question is what it cost.
    const b = budget({ dailyCostUsd: 1 });
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 0.85 }, 'development');

    expect(labels().some((l) => l.includes('development 100/10 $0.85'))).toBe(true);
  });

  it('survives the day rolling over by starting the money at zero too', () => {
    const b = budget({ dailyCostUsd: 10 });
    b.record({ inputTokens: 100, outputTokens: 10, costUsd: 9.9 }, 'development');
    clock += 86_400_000;

    expect(b.check().ok).toBe(true);
    expect(b.snapshot().costUsd).toBe(0);
  });
});
