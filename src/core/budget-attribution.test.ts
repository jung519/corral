/**
 * Who spent the shared day.
 *
 * The ceiling stays shared — that is the operator's own decision (D12), and splitting it
 * would leave one side idle while the other is blocked. What was missing is the thing the
 * operational design already asked for: *"the ceiling is on screen at all times so that the
 * development AI eating the shared budget shows immediately"*. Attribution is what makes
 * that sentence true; without it a stopped pipeline and a spent day were two facts on
 * screen with nothing connecting them (CRL-110).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenBudget } from './token-budget.js';
import { bus } from './events.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'crl110-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const budget = (limits = {}, now = () => Date.parse('2026-08-25T10:00:00')) => new TokenBudget(limits, dir, { now });

describe('per-pillar tallies', () => {
  it('keeps each side separately and the total intact', () => {
    const b = budget();
    b.record({ inputTokens: 100, outputTokens: 10 }, 'development');
    b.record({ inputTokens: 30, outputTokens: 5 }, 'operations');
    b.record({ inputTokens: 20, outputTokens: 1 }, 'development');

    const s = b.snapshot();
    expect(s.byPillar.development).toEqual({ inputTokens: 120, outputTokens: 11 });
    expect(s.byPillar.operations).toEqual({ inputTokens: 30, outputTokens: 5 });
    // The ceiling is still checked against this, so nothing about when work stops changes.
    expect([s.inputTokens, s.outputTokens]).toEqual([150, 16]);
  });

  it('leaves a pillar out until it spends', () => {
    const b = budget();
    b.record({ inputTokens: 5, outputTokens: 0 }, 'operations');
    expect(b.snapshot().byPillar.development).toBeUndefined();
  });

  it('resets the split when the day rolls over', () => {
    let clock = Date.parse('2026-08-25T23:59:00');
    const b = budget({}, () => clock);
    b.record({ inputTokens: 100, outputTokens: 0 }, 'development');
    clock = Date.parse('2026-08-26T00:01:00');
    const s = b.snapshot();
    expect(s.byPillar).toEqual({});
    expect(s.inputTokens).toBe(0);
  });
});

describe('a counter file written before attribution existed', () => {
  /**
   * Showing `development 0 / operations 0` against a total of 500k would be a false
   * statement, not a conservative one. Same reasoning as an absent `criteria` block
   * (CRL-108) and an unreadable HEAD (CRL-109): report the gap, do not guess into it.
   */
  it('reports the old spend as unattributed rather than as zero', () => {
    writeFileSync(
      join(dir, 'token-budget.json'),
      JSON.stringify({ date: '2026-08-25', inputTokens: 500_000, outputTokens: 9_000, announced: [] }),
    );
    const s = budget().snapshot();
    expect(s.byPillar).toEqual({});
    expect(s.unattributed).toEqual({ inputTokens: 500_000, outputTokens: 9_000 });
  });

  it('does not fold later attributed spend into the unknown part', () => {
    writeFileSync(
      join(dir, 'token-budget.json'),
      JSON.stringify({ date: '2026-08-25', inputTokens: 100, outputTokens: 0, announced: [] }),
    );
    const b = budget();
    b.record({ inputTokens: 40, outputTokens: 0 }, 'development');
    const s = b.snapshot();
    expect(s.unattributed.inputTokens).toBe(100);
    expect(s.byPillar.development?.inputTokens).toBe(40);
    expect(s.inputTokens).toBe(140);
  });

  it('reports nothing unknown once every token is accounted for', () => {
    const b = budget();
    b.record({ inputTokens: 10, outputTokens: 2 }, 'operations');
    expect(b.snapshot().unattributed).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('the message when the day runs out', () => {
  let seen: string[] = [];
  let unsubscribe: (() => void) | undefined;
  beforeEach(() => {
    seen = [];
    unsubscribe = bus.subscribe((e) => {
      if (e.identifier === 'token-budget') seen.push(e.label);
    });
  });
  afterEach(() => unsubscribe?.());

  it('names which side spent it', () => {
    // The operator reads this line and has to be able to tell why the pipeline is quiet.
    const b = budget({ dailyInputTokens: 100 });
    b.record({ inputTokens: 90, outputTokens: 0 }, 'development');
    b.record({ inputTokens: 20, outputTokens: 0 }, 'operations');

    const stopped = seen.find((l) => l.includes('limit reached'));
    expect(stopped).toBeDefined();
    expect(stopped).toContain('development 90/0');
    expect(stopped).toContain('operations 20/0');
  });

  it('names the unknown part too', () => {
    writeFileSync(
      join(dir, 'token-budget.json'),
      JSON.stringify({ date: '2026-08-25', inputTokens: 95, outputTokens: 0, announced: [] }),
    );
    budget({ dailyInputTokens: 100 }).record({ inputTokens: 10, outputTokens: 0 }, 'operations');
    expect(seen.find((l) => l.includes('limit reached'))).toContain('unattributed 95/0');
  });
});

describe('what did not change', () => {
  /**
   * Acceptance criterion 3: the ceiling behaves exactly as before. Attribution is a
   * reporting change; the moment work stops is decided by the shared total, as it was.
   */
  it('blocks at the same point regardless of which side spent it', () => {
    const dev = budget({ dailyInputTokens: 100 });
    dev.record({ inputTokens: 100, outputTokens: 0 }, 'development');
    expect(dev.check().ok).toBe(false);

    rmSync(join(dir, 'token-budget.json'), { force: true });
    const ops = budget({ dailyInputTokens: 100 });
    ops.record({ inputTokens: 100, outputTokens: 0 }, 'operations');
    expect(ops.check().ok).toBe(false);
  });

  it('blocks on a mixed spend that crosses together', () => {
    // The whole point of a shared ceiling: neither side has a private allowance.
    const b = budget({ dailyInputTokens: 100 });
    b.record({ inputTokens: 60, outputTokens: 0 }, 'development');
    expect(b.check().ok).toBe(true);
    b.record({ inputTokens: 40, outputTokens: 0 }, 'operations');
    expect(b.check().ok).toBe(false);
  });
});
