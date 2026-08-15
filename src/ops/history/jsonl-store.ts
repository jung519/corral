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
 * The totals file is a cache, never the truth. It's rewritten after each append so
 * reading a day is one small parse, but it is recomputed from the log whenever it is
 * missing or disagrees about the count — a totals file that quietly drifted from the runs
 * it summarizes would be worse than not having one.
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
  OPS_HISTORY_SCHEMA_VERSION,
  summarize,
  type OpsDailyTotals,
  type OpsHistoryQuery,
  type OpsHistoryStore,
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
    this.writeTotals(date);
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

  private writeTotals(date: string): OpsDailyTotals {
    const totals = summarize(date, this.read(date));
    writeFileSync(this.totalsPath(date), JSON.stringify(totals, null, 2), 'utf8');
    return totals;
  }

  /** Days to look at, newest first, today included. */
  private recentDays(days: number): string[] {
    const today = this.now();
    return Array.from({ length: Math.max(1, days) }, (_, i) => dayKey(today - i * 86_400_000));
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
      const records = this.read(date);
      if (!records.length && !existsSync(this.totalsPath(date))) continue;

      const cached = this.readTotals(date);
      // Trust the cache only while it still describes the same log. Anything else — a
      // hand-edited file, a crash between the append and the rewrite — and we recount.
      out.push(cached && cached.runs === records.length ? cached : this.writeTotals(date));
    }
    return out;
  }

  private readTotals(date: string): OpsDailyTotals | undefined {
    try {
      return JSON.parse(readFileSync(this.totalsPath(date), 'utf8')) as OpsDailyTotals;
    } catch {
      return undefined;
    }
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
