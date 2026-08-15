/**
 * One ceiling, both pillars. The questions that matter: does spending on one side stop
 * the other, is the check made before the money is gone rather than after, and does the
 * warning stay a warning instead of becoming noise.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, type CorralEvent } from './events.js';
import { TokenBudget } from './token-budget.js';

let dir: string;
let clock: number;
let seen: CorralEvent[];
let unsubscribe: () => void;

const NOON = new Date(2026, 7, 15, 12, 0, 0).getTime();
const DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-budget-'));
  clock = NOON;
  seen = [];
  unsubscribe = bus.subscribe((e) => seen.push(e));
});
afterEach(() => {
  unsubscribe();
  rmSync(dir, { recursive: true, force: true });
});

const budget = (limits = { dailyInputTokens: 1000, dailyOutputTokens: 500 }) =>
  new TokenBudget(limits, dir, { now: () => clock });

describe('sharing one counter', () => {
  it('lets spending recorded by either side close the door for both', () => {
    const b = budget({ dailyInputTokens: 100, dailyOutputTokens: 0 });

    // Whoever spent it — an issue being planned, a pipeline classifying a record — it is
    // the same account and the same day.
    b.record({ inputTokens: 60, outputTokens: 0 });
    expect(b.check().ok).toBe(true);

    b.record({ inputTokens: 45, outputTokens: 0 });
    expect(b.check()).toMatchObject({ ok: false, reason: expect.stringContaining('input token limit') });
  });

  it('stops on the output ceiling too', () => {
    const b = budget({ dailyOutputTokens: 100 });

    b.record({ inputTokens: 99_999, outputTokens: 100 });

    expect(b.check()).toMatchObject({ ok: false, reason: expect.stringContaining('output token limit') });
  });

  it('never blocks when no ceiling is configured', () => {
    const b = budget({});

    b.record({ inputTokens: 10_000_000, outputTokens: 10_000_000 });

    expect(b.check().ok).toBe(true);
    expect(b.configured).toBe(false);
  });
});

describe('the tally surviving a restart', () => {
  it('is not handed out twice', () => {
    budget({ dailyInputTokens: 100 }).record({ inputTokens: 90, outputTokens: 0 });

    // A core restarted at lunchtime must not give back the morning's tokens.
    expect(budget({ dailyInputTokens: 100 }).check().ok).toBe(true);
    budget({ dailyInputTokens: 100 }).record({ inputTokens: 20, outputTokens: 0 });
    expect(budget({ dailyInputTokens: 100 }).check().ok).toBe(false);
  });

  it('starts fresh on a new day', () => {
    budget({ dailyInputTokens: 100 }).record({ inputTokens: 200, outputTokens: 0 });
    expect(budget({ dailyInputTokens: 100 }).check().ok).toBe(false);

    clock += DAY;

    expect(budget({ dailyInputTokens: 100 }).check().ok).toBe(true);
  });

  it('rolls over mid-process, not just on restart', () => {
    const b = budget({ dailyInputTokens: 100 });
    b.record({ inputTokens: 200, outputTokens: 0 });
    expect(b.check().ok).toBe(false);

    clock += DAY;

    expect(b.check().ok).toBe(true);
    expect(b.snapshot().inputTokens).toBe(0);
  });

  it('treats an unreadable file as a fresh day rather than refusing to run', () => {
    writeFileSync(join(dir, 'token-budget.json'), 'not json');

    expect(budget().check().ok).toBe(true);
  });
});

describe('telling someone', () => {
  const notices = () => seen.filter((e) => e.identifier === 'token-budget');

  it('announces each threshold once, on the call that crosses it', () => {
    const b = budget({ dailyInputTokens: 100 });

    b.record({ inputTokens: 20, outputTokens: 0 }); // 20%
    expect(notices()).toHaveLength(0);

    b.record({ inputTokens: 35, outputTokens: 0 }); // 55%
    b.record({ inputTokens: 5, outputTokens: 0 }); // 60% — still past 50 only
    expect(notices().map((e) => e.data?.threshold)).toEqual([50]);

    b.record({ inputTokens: 25, outputTokens: 0 }); // 85%
    b.record({ inputTokens: 20, outputTokens: 0 }); // 105%
    expect(notices().map((e) => e.data?.threshold)).toEqual([50, 80, 100]);
  });

  it('does not repeat itself once the limit is spent', () => {
    const b = budget({ dailyInputTokens: 10 });

    for (let i = 0; i < 20; i++) b.record({ inputTokens: 10, outputTokens: 0 });

    // A limit that shouts on every call is noise, and noise is how people stop reading.
    expect(notices().filter((e) => e.data?.threshold === 100)).toHaveLength(1);
  });

  it('raises the last one as an error, not a passing remark', () => {
    const b = budget({ dailyInputTokens: 10 });

    b.record({ inputTokens: 10, outputTokens: 0 });

    expect(notices().at(-1)).toMatchObject({ kind: 'error' });
  });

  it('says nothing at all when no ceiling is configured', () => {
    budget({}).record({ inputTokens: 999_999, outputTokens: 999_999 });

    expect(notices()).toHaveLength(0);
  });

  it('announces again the next day', () => {
    const b = budget({ dailyInputTokens: 10 });
    b.record({ inputTokens: 10, outputTokens: 0 });
    seen = [];

    clock += DAY;
    b.record({ inputTokens: 10, outputTokens: 0 });

    expect(notices().map((e) => e.data?.threshold)).toEqual([50, 80, 100]);
  });
});

describe('what it reports', () => {
  it('gives the fraction of the tightest ceiling', () => {
    const b = budget({ dailyInputTokens: 1000, dailyOutputTokens: 100 });

    b.record({ inputTokens: 100, outputTokens: 50 });

    // Input is 10% used, output 50% — the one that will stop work first is the one to show.
    expect(b.snapshot()).toMatchObject({ inputTokens: 100, outputTokens: 50, used: 0.5 });
  });

  it('writes the day and the tally where a restart can find them', () => {
    budget().record({ inputTokens: 7, outputTokens: 3 });

    expect(JSON.parse(readFileSync(join(dir, 'token-budget.json'), 'utf8'))).toMatchObject({
      date: '2026-08-15',
      inputTokens: 7,
      outputTokens: 3,
    });
  });
});
