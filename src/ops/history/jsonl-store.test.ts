/**
 * The history is what an operator reads the morning after. It has to hold one line per
 * run, add up to the same thing the runs did, and survive the ways files actually break.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../pipeline/run.js';
import { JsonlOpsHistoryStore, OPS_HISTORY_DIR } from './jsonl-store.js';
import { dayKey, rounded, summarize } from './store.js';

let dir: string;
let clock: number;
const DAY = 86_400_000;

/** A fixed instant so day boundaries are exact: 2026-08-15 12:00 local. */
const NOON = new Date(2026, 7, 15, 12, 0, 0).getTime();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-ops-history-'));
  clock = NOON;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = (retentionDays?: number): JsonlOpsHistoryStore =>
  new JsonlOpsHistoryStore(dir, { retentionDays, now: () => clock });

function run(over: Partial<RunRecord> = {}): RunRecord {
  const startedAt = over.startedAt ?? clock;
  return {
    id: `classify-${startedAt}-${Math.random()}`,
    pipeline: 'classify',
    startedAt,
    endedAt: startedAt + 1500,
    outcome: 'completed',
    tokens: 100,
    costUsd: 0.01,
    provider: 'claude',
    ...over,
  };
}

const logFile = (date: string): string => join(dir, OPS_HISTORY_DIR, `${date}.jsonl`);

describe('one run, one line', () => {
  it('writes what an operator needs to identify the run and what it cost', async () => {
    const s = store();

    await s.append(run({ startedAt: clock, endedAt: clock + 2400, model: 'sonnet' }));

    const lines = readFileSync(logFile('2026-08-15'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      v: 1,
      pipeline: 'classify',
      outcome: 'completed',
      tokens: 100,
      durationMs: 2400,
      provider: 'claude',
      model: 'sonnet',
    });
  });

  it('files a run under the day it started, not the day it was written', async () => {
    // A run beginning at 23:59:59 belongs to that day; "now" would push it into the next.
    const lateLastNight = new Date(2026, 7, 14, 23, 59, 59).getTime();

    await store().append(run({ startedAt: lateLastNight, endedAt: lateLastNight + 3000 }));

    expect(existsSync(logFile('2026-08-14'))).toBe(true);
    expect(existsSync(logFile('2026-08-15'))).toBe(false);
  });

  it('appends rather than rewriting, so a crash costs one run at most', async () => {
    const s = store();

    await s.append(run());
    await s.append(run());
    await s.append(run());

    expect(readFileSync(logFile('2026-08-15'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('the daily totals', () => {
  it('match the runs that actually happened', async () => {
    const s = store();
    await s.append(run({ outcome: 'completed', tokens: 100, costUsd: 0.01 }));
    await s.append(run({ outcome: 'completed', tokens: 250, costUsd: 0.02, failedOver: true }));
    await s.append(run({ outcome: 'reported', tokens: 80, costUsd: 0.005, lowConfidence: true }));
    await s.append(run({ outcome: 'agent_failed', stage: 'agent', tokens: undefined, costUsd: undefined }));
    await s.append(run({ outcome: 'skipped', stage: 'input', tokens: undefined, costUsd: undefined }));

    const [today] = await s.totals(1);

    expect(today).toMatchObject({
      date: '2026-08-15',
      runs: 5,
      tokens: 430,
      costUsd: 0.035,
      failedOver: 1,
      lowConfidence: 1,
      failed: 1, // a skip is not a failure; neither is a held-back result
      byOutcome: { completed: 2, reported: 1, agent_failed: 1, skipped: 1 },
    });
  });

  it('counts a low-confidence answer however the pipeline chose to end it', async () => {
    const s = store();
    // The same fact, three endings. Without the flag, the middle one is indistinguishable
    // from a skip_if skip and the day's count would be wrong.
    await s.append(run({ outcome: 'reported', lowConfidence: true }));
    await s.append(run({ outcome: 'skipped', lowConfidence: true }));
    await s.append(run({ outcome: 'completed', lowConfidence: true }));
    await s.append(run({ outcome: 'skipped' }));

    expect((await s.totals(1))[0].lowConfidence).toBe(3);
  });

  it('is rebuilt when the file disagrees with the log', async () => {
    const s = store();
    await s.append(run({ tokens: 100 }));
    await s.append(run({ tokens: 100 }));

    // Someone edited it, or we died between the append and the rewrite.
    writeFileSync(
      join(dir, OPS_HISTORY_DIR, '2026-08-15.totals.json'),
      JSON.stringify({ date: '2026-08-15', runs: 99, tokens: 1, byOutcome: {}, costUsd: 0, failedOver: 0, lowConfidence: 0, failed: 0 }),
    );

    // The log is the truth; the totals file is a cache and gets recomputed.
    expect((await s.totals(1))[0]).toMatchObject({ runs: 2, tokens: 200 });
  });

  it('is rebuilt when the file is gone entirely', async () => {
    const s = store();
    await s.append(run({ tokens: 42 }));
    rmSync(join(dir, OPS_HISTORY_DIR, '2026-08-15.totals.json'));

    expect((await s.totals(1))[0]).toMatchObject({ runs: 1, tokens: 42 });
  });

  it('reports each day separately, newest first', async () => {
    const s = store();
    await s.append(run({ startedAt: clock - 2 * DAY }));
    await s.append(run({ startedAt: clock - DAY }));
    await s.append(run({ startedAt: clock }));

    expect((await s.totals(3)).map((t) => t.date)).toEqual(['2026-08-15', '2026-08-14', '2026-08-13']);
  });

  it('says nothing about days with no runs rather than inventing zeroes', async () => {
    const s = store();
    await s.append(run());

    expect(await s.totals(7)).toHaveLength(1);
  });
});

describe('looking back over N days', () => {
  beforeEach(async () => {
    const s = store();
    await s.append(run({ startedAt: clock - 3 * DAY, outcome: 'agent_failed' }));
    await s.append(run({ startedAt: clock - DAY, pipeline: 'summarize' }));
    await s.append(run({ startedAt: clock, outcome: 'completed' }));
  });

  it('includes only the days asked for', async () => {
    expect(await store().list({ days: 1 })).toHaveLength(1);
    expect(await store().list({ days: 2 })).toHaveLength(2);
    expect(await store().list({ days: 7 })).toHaveLength(3);
  });

  it('returns the newest run first', async () => {
    const [newest] = await store().list({ days: 7 });

    expect(dayKey(newest.startedAt)).toBe('2026-08-15');
  });

  it('filters by pipeline and by outcome', async () => {
    expect((await store().list({ days: 7, pipeline: 'summarize' })).map((r) => r.pipeline)).toEqual(['summarize']);
    expect((await store().list({ days: 7, outcome: 'agent_failed' })).map((r) => r.outcome)).toEqual(['agent_failed']);
  });

  it('stops at the limit instead of reading everything first', async () => {
    expect(await store().list({ days: 7, limit: 2 })).toHaveLength(2);
  });
});

describe('retention', () => {
  it('drops days past the window and keeps the rest', async () => {
    const s = store(7);
    await s.append(run({ startedAt: clock - 30 * DAY }));
    await s.append(run({ startedAt: clock - 2 * DAY }));
    await s.append(run({ startedAt: clock }));

    const removed = await s.prune();

    // Both the log and its totals file for the old day.
    expect(removed).toBe(2);
    expect(existsSync(logFile('2026-08-15'))).toBe(true);
    expect(existsSync(logFile('2026-08-13'))).toBe(true);
  });

  it('leaves alone anything it does not recognise', async () => {
    const s = store(1);
    await s.append(run());
    writeFileSync(join(dir, OPS_HISTORY_DIR, 'notes.txt'), 'mine');

    await s.prune();

    // Pruning deletes files. Anything not matching the naming scheme is somebody else's.
    expect(readdirSync(join(dir, OPS_HISTORY_DIR))).toContain('notes.txt');
  });

  it('is fine when there is nothing to prune', async () => {
    await expect(store(7).prune()).resolves.toBe(0);
  });
});

/**
 * A day is a local day here on purpose — the operator's day, not UTC's. Where daylight
 * saving is observed a local day is 23 or 25 hours long twice a year, so the window used to
 * be walked back with an interval no local day actually has (CRL-55).
 *
 * Both directions were measured to lose or double a day, from a clock only an hour either
 * side of local midnight. These pin the boundary rather than the arithmetic, because the
 * arithmetic is what was wrong.
 */
describe('a day is however long that day was', () => {
  const TZ = process.env.TZ;
  /** Whatever the run is, on the day it actually happened locally. */
  const onDay = (iso: string, over: Partial<RunRecord> = {}): RunRecord =>
    run({ startedAt: new Date(iso).getTime(), ...over });

  beforeEach(() => {
    process.env.TZ = 'America/New_York';
  });
  afterEach(() => {
    if (TZ === undefined) delete process.env.TZ;
    else process.env.TZ = TZ;
  });

  it('keeps a file from inside the window when the day before was 23 hours', async () => {
    // 2026-03-08 lost an hour at 02:00. Standing just after midnight on the 9th, a flat
    // 24-hour step skipped the 8th entirely — and prune deletes whatever it did not list.
    clock = new Date('2026-03-09T04:30:00Z').getTime(); // 00:30 local, EDT
    const s = store(10);
    await s.append(onDay('2026-03-08T18:00:00Z')); // mid-afternoon on the 8th, local
    await s.append(run());

    await s.prune();

    expect(existsSync(logFile('2026-03-08'))).toBe(true);
  });

  it('counts a 25-hour day once, not twice', async () => {
    // 2026-11-01 gained an hour at 02:00. Standing late that evening, a flat 24-hour step
    // landed back inside the same local day.
    clock = new Date('2026-11-02T04:30:00Z').getTime(); // 23:30 local on the 1st, EST
    const s = store();
    for (let i = 0; i < 3; i++) await s.append(onDay('2026-11-01T20:00:00Z'));

    const counts = await s.countsByPipeline(4);
    const listed = await s.list({ days: 4 });

    expect(counts.classify).toMatchObject({ runs: 3, tokens: 300 });
    expect(listed).toHaveLength(3);
  });

  it('asks for as many distinct days as it was told to', async () => {
    clock = new Date('2026-11-02T04:30:00Z').getTime();
    const s = store();

    // One append per local day, walking back the same way the store now does.
    const days: string[] = [];
    const d = new Date(clock);
    for (let i = 0; i < 5; i++) {
      days.push(dayKey(d.getTime()));
      await s.append(run({ startedAt: d.getTime() }));
      d.setDate(d.getDate() - 1);
    }

    // Five days asked for, five days found — no repeats swallowing one of them.
    expect(new Set(days).size).toBe(5);
    expect((await s.totals(5)).map((t) => t.date)).toEqual(days);
  });
});

describe('when the files are damaged', () => {
  it('loses the bad line and keeps the day', async () => {
    const s = store();
    await s.append(run({ tokens: 10 }));
    // A kill mid-append leaves a half-written line.
    writeFileSync(logFile('2026-08-15'), `${readFileSync(logFile('2026-08-15'), 'utf8')}{"id":"half`, 'utf8');
    await s.append(run({ tokens: 20 }));

    const totals = (await s.totals(1))[0];

    expect(totals.runs).toBe(2);
    expect(totals.tokens).toBe(30);
  });

  it('treats a missing history directory as an empty history', async () => {
    const s = new JsonlOpsHistoryStore(join(dir, 'nothing-here'), { now: () => clock });

    await expect(s.list()).resolves.toEqual([]);
    await expect(s.totals()).resolves.toEqual([]);
    await expect(s.prune()).resolves.toBe(0);
  });
});

describe('per-pipeline counts', () => {
  it('groups today by pipeline, with what a dashboard row shows', async () => {
    const s = store();
    await s.append(run({ pipeline: 'classify', outcome: 'completed', tokens: 100 }));
    await s.append(run({ pipeline: 'classify', outcome: 'reported', tokens: 50, lowConfidence: true }));
    await s.append(run({ pipeline: 'classify', outcome: 'agent_failed', tokens: undefined }));
    await s.append(run({ pipeline: 'summarize', outcome: 'completed', tokens: 10 }));

    expect(await s.countsByPipeline(1)).toEqual({
      classify: { runs: 3, failed: 1, lowConfidence: 1, tokens: 150 },
      summarize: { runs: 1, failed: 0, lowConfidence: 0, tokens: 10 },
    });
  });

  it('leaves out a pipeline that did nothing today', async () => {
    const s = store();
    await s.append(run({ pipeline: 'classify', startedAt: clock - DAY }));

    // An absent key is how the dashboard shows a zero without the store inventing rows
    // for pipelines it has never heard of.
    expect(await s.countsByPipeline(1)).toEqual({});
  });

  it('is empty rather than failing when nothing has run at all', async () => {
    await expect(store().countsByPipeline(1)).resolves.toEqual({});
  });
});

describe('summing', () => {
  it('does not let float addition show up as a price', () => {
    const cents = Array.from({ length: 3 }, () => ({ outcome: 'completed', costUsd: 0.1 }) as never);

    // Rounded on the way out rather than inside the sum: a total built one run at a time
    // has to be the same arithmetic as one rebuilt from the log, and rounding each step
    // would quietly make them different (CRL-52).
    expect(rounded(summarize('2026-08-15', cents)).costUsd).toBe(0.3);
  });

  it('gives the same price whether it was added up or rebuilt', async () => {
    const s = store();
    for (const costUsd of [0.1, 0.1, 0.1, 0.07, 0.003]) await s.append(run({ costUsd }));

    const addedUp = (await s.totals(1))[0]; // the stored total, folded run by run
    rmSync(join(dir, OPS_HISTORY_DIR, '2026-08-15.totals.json'));
    const rebuilt = (await s.totals(1))[0]; // recomputed from the log

    expect(addedUp).toEqual(rebuilt);
    expect(addedUp.costUsd).toBe(0.373);
  });
});

/**
 * Recording the N-th run of a day used to cost N line-parses: `append` rebuilt the totals
 * from the whole log every time. Measured at 5.4 seconds of synchronous blocking across a
 * 5,000-run day and 81 seconds across a 20,000-run one — in front of the queue loop and
 * the schedule tick (CRL-52).
 *
 * Timing is too shaky to assert, so these pin the thing that made it slow: whether the day
 * is read at all.
 */
describe('what it costs to record a run', () => {
  /** Watch the one private method that parses a whole day. */
  const watchRead = (s: JsonlOpsHistoryStore) => vi.spyOn(s as unknown as { read: (d: string) => unknown[] }, 'read');

  it('does not read the day back', async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await s.append(run());

    const read = watchRead(s);
    await s.append(run());

    expect(read).not.toHaveBeenCalled();
  });

  it('still counts everything, however many there are', async () => {
    const s = store();
    for (let i = 0; i < 50; i++) await s.append(run({ tokens: 10, costUsd: 0.01 }));

    expect((await s.totals(1))[0]).toMatchObject({ runs: 50, tokens: 500, costUsd: 0.5 });
  });

  it('reads the day only when the stored total no longer describes it', async () => {
    const s = store();
    await s.append(run());
    await s.totals(1); // warm

    const read = watchRead(s);
    await s.totals(1);
    expect(read).not.toHaveBeenCalled(); // the log has not moved

    appendFileSync(logFile('2026-08-15'), `${JSON.stringify({ v: 1, pipeline: 'classify', outcome: 'completed', startedAt: clock, durationMs: 1, tokens: 7 })}\n`);
    expect((await s.totals(1))[0]).toMatchObject({ runs: 2, tokens: 107 });
    expect(read).toHaveBeenCalled(); // it did, so the day was rebuilt
  });
});

describe('no native modules', () => {
  it('is built out of Node builtins alone', () => {
    // Electron runs Node 20, so `node:sqlite` isn't there, and a compiled dependency
    // would mean building per platform. Plain text is what keeps one repo shipping to
    // macOS and Windows — so this store must not reach for a package to do its job.
    for (const file of ['./jsonl-store.ts', './store.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

      expect(specifiers.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))).toEqual([]);
    }
  });
});
