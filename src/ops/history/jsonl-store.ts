/**
 * Run history on disk: one JSON Lines file per day, plus that day's totals beside it.
 *
 *   <stateDir>/ops-history/2026-08-15.jsonl
 *   <stateDir>/ops-history/2026-08-15.totals.json
 *
 * **No native modules.** `node:sqlite` isn't available in Electron (Node 20), and any
 * compiled dependency would mean building per platform — the desktop app ships for macOS
 * and Windows from one repo and that has to keep working. Append-only text costs nothing
 * to write, and one corrupt line loses one run instead of the file.
 *
 * The totals file is a cache, never the truth. It's kept current as runs are appended so
 * reading a day is one small parse, but it is recomputed from the log whenever it is
 * missing or disagrees about the count — a totals file that quietly drifted from the runs
 * it summarizes would be worse than not having one.
 *
 * **Both of those sentences used to be false in the same way: by parsing the whole day.**
 * Each append rebuilt the totals from the entire log, so recording the N-th run of a day
 * cost N line-parses — 5.4 seconds of blocking across a 5,000-run day, 81 seconds across a
 * 20,000-run one, all of it synchronous and all of it in front of the queue loop and the
 * schedule tick. And the read side parsed the day anyway, just to count the lines it was
 * comparing against. Now a run is folded into the stored total as it arrives, and the
 * cache is checked against the log's size — one `stat` (CRL-52).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../../core/logger.js';
import type { RunRecord } from '../pipeline/run.js';
import {
  dayKey,
  FAILURE_OUTCOMES,
  OPS_HISTORY_SCHEMA_VERSION,
  addTo,
  emptyTotals,
  rounded,
  summarize,
  type OpsDailyTotals,
  type OpsHistoryQuery,
  type OpsHistoryStore,
  type OpsPipelineCounts,
  type OpsRunRecord,
} from './store.js';

export const OPS_HISTORY_DIR = 'ops-history';
/** Long enough to explain last month's bill, short enough to stay small. */
export const DEFAULT_RETENTION_DAYS = 90;

export interface JsonlOpsHistoryOptions {
  retentionDays?: number;
  /** Injectable clock, so tests can write across day boundaries. */
  now?: () => number;
}

/**
 * A day's total as it sits on disk: the total itself, plus the size of the log it was
 * computed from. The size is bookkeeping for the cache and never leaves this file.
 */
interface StoredTotals extends OpsDailyTotals {
  logBytes: number;
}

export class JsonlOpsHistoryStore implements OpsHistoryStore {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly now: () => number;

  constructor(stateDir: string, options: JsonlOpsHistoryOptions = {}) {
    this.dir = resolve(stateDir, OPS_HISTORY_DIR);
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.now = options.now ?? (() => Date.now());
  }

  private logPath(date: string): string {
    return join(this.dir, `${date}.jsonl`);
  }

  private totalsPath(date: string): string {
    return join(this.dir, `${date}.totals.json`);
  }

  async append(run: RunRecord): Promise<void> {
    const record: OpsRunRecord = {
      v: OPS_HISTORY_SCHEMA_VERSION,
      id: run.id,
      pipeline: run.pipeline,
      outcome: run.outcome,
      stage: run.stage,
      reason: run.reason,
      startedAt: run.startedAt,
      durationMs: Math.max(0, run.endedAt - run.startedAt),
      tokens: run.tokens,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
      provider: run.provider,
      model: run.model,
      failedOver: run.failedOver,
      lowConfidence: run.lowConfidence,
      dropped: run.dropped,
      reviewUrl: run.reviewUrl,
    };

    // The run's own start decides which day it belongs to. Using "now" instead would
    // file a run that began at 23:59:59 under the next day.
    const date = dayKey(record.startedAt);
    mkdirSync(this.dir, { recursive: true });
    const path = this.logPath(date);
    // If the last append was cut short (a kill mid-write), the file ends without a
    // newline and appending straight on would fuse the stump to this record — losing
    // this run as well as the last one. One byte of checking keeps the damage to one.
    const separator = endsWithNewline(path) ? '' : '\n';
    appendFileSync(path, `${separator}${JSON.stringify(record)}\n`, 'utf8');

    // Folded into what is already there rather than recomputed from the log. Nothing here
    // checks whether that stored total was still accurate: if it had drifted, this makes it
    // no worse, and `totals()` rebuilds it the moment the log disagrees. Paying a whole-day
    // parse on every append to find out sooner is what this issue was.
    this.storeTotals(date, addTo(this.readTotals(date) ?? emptyTotals(date), record));
  }

  /** Records for one day, in the order they happened. Bad lines are skipped, not fatal. */
  private read(date: string): OpsRunRecord[] {
    const path = this.logPath(date);
    if (!existsSync(path)) return [];
    const out: OpsRunRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as OpsRunRecord);
      } catch {
        // A half-written last line (a kill mid-append) must not cost us the day.
        logger.warn(`ops history: skipping unreadable line in ${date}.jsonl`);
      }
    }
    return out;
  }

  /** Rebuild a day's total from its log — the path taken whenever the cache is not trusted. */
  private writeTotals(date: string): OpsDailyTotals {
    const totals = summarize(date, this.read(date));
    this.storeTotals(date, totals);
    return totals;
  }

  /**
   * Write a day's total, stamped with the size of the log it describes.
   *
   * The stamp is what makes the cache cheap to trust. Counting runs meant reading the log;
   * counting its bytes is one `stat`. It is also stricter in the right way — a hand-edited
   * or truncated line changes the size, where a line count would not notice a line being
   * rewritten, and a half-written line would leave the count permanently one out.
   */
  private storeTotals(date: string, totals: OpsDailyTotals): void {
    const stamped: StoredTotals = { ...totals, logBytes: this.logSize(date) };
    writeFileSync(this.totalsPath(date), JSON.stringify(stamped, null, 2), 'utf8');
  }

  private logSize(date: string): number {
    try {
      return statSync(this.logPath(date)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Days to look at, newest first, today included.
   *
   * Counted in days rather than milliseconds. `dayKey` builds a *local* date — the
   * operator's day, deliberately — and a local day is 23 or 25 hours long twice a year
   * wherever daylight saving is observed. Subtracting a flat 86,400,000 across that
   * boundary measured wrong in both directions, from a clock only an hour either side of
   * local midnight:
   *
   * - spring forward, the day after: `[03-09, 03-07, 03-06, …]` — 03-08 gone from the list
   *   altogether, and `prune` deleted its file from inside the retention window
   * - fall back, late that evening: `[11-01, 11-01, 10-31, …]` — one day counted twice, so
   *   runs and tokens came back at exactly double, and the far end of the window was one
   *   day short, so `prune` deleted that file instead
   *
   * `setDate` knows how long its own day is, and rolls months and years on its own (CRL-55).
   */
  private recentDays(days: number): string[] {
    const day = new Date(this.now());
    const out: string[] = [];
    for (let i = Math.max(1, days); i > 0; i--) {
      out.push(dayKey(day.getTime()));
      day.setDate(day.getDate() - 1);
    }
    return out;
  }

  async list(query: OpsHistoryQuery = {}): Promise<OpsRunRecord[]> {
    const out: OpsRunRecord[] = [];
    for (const date of this.recentDays(query.days ?? 7)) {
      // Newest first within the day too — the reader wants the latest run, not the
      // day's first.
      for (const record of this.read(date).reverse()) {
        if (query.pipeline && record.pipeline !== query.pipeline) continue;
        if (query.outcome && record.outcome !== query.outcome) continue;
        out.push(record);
        if (query.limit && out.length >= query.limit) return out;
      }
    }
    return out;
  }

  async totals(days = 7): Promise<OpsDailyTotals[]> {
    const out: OpsDailyTotals[] = [];
    for (const date of this.recentDays(days)) {
      // One `stat`, not a parse of the day. The question is only "does the cache still
      // describe this log", and answering it by parsing every line made the cache pointless
      // on the one path it exists for.
      const bytes = this.logSize(date);
      if (!bytes && !existsSync(this.totalsPath(date))) continue;

      const cached = this.readTotals(date);
      // Trust the cache only while it still describes the same log. Anything else — a
      // hand-edited file, a crash between the append and the rewrite — and we recount.
      out.push(rounded(cached && cached.logBytes === bytes ? cached : this.writeTotals(date)));
    }
    return out;
  }

  private readTotals(date: string): StoredTotals | undefined {
    try {
      return JSON.parse(readFileSync(this.totalsPath(date), 'utf8')) as StoredTotals;
    } catch {
      return undefined;
    }
  }

  async countsByPipeline(days = 1): Promise<Record<string, OpsPipelineCounts>> {
    const out: Record<string, OpsPipelineCounts> = {};
    for (const date of this.recentDays(days)) {
      for (const r of this.read(date)) {
        const c = (out[r.pipeline] ??= { runs: 0, failed: 0, lowConfidence: 0, tokens: 0 });
        c.runs++;
        c.tokens += r.tokens ?? 0;
        if (r.lowConfidence) c.lowConfidence++;
        if (FAILURE_OUTCOMES.includes(r.outcome)) c.failed++;
      }
    }
    return out;
  }

  async prune(): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    const keep = new Set(this.recentDays(this.retentionDays));
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const date = name.match(/^(\d{4}-\d{2}-\d{2})\.(jsonl|totals\.json)$/)?.[1];
      if (!date || keep.has(date)) continue; // anything we don't recognise stays put
      rmSync(join(this.dir, name), { force: true });
      removed++;
    }
    if (removed) logger.info(`ops history: pruned ${removed} file(s) older than ${this.retentionDays} days`);
    return removed;
  }
}

/** Whether the file's last byte is a newline. Reads one byte, not the file. */
function endsWithNewline(path: string): boolean {
  if (!existsSync(path)) return true; // nothing to fuse to
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
