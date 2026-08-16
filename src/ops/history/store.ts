/**
 * What a run history has to be able to answer, independent of where it's kept.
 *
 * The interface comes first on purpose (D16). JSONL is the right backend at this volume
 * and it's the only one that keeps the cross-platform build simple — but "how many runs
 * failed yesterday" will outlive that choice, so call sites are written against this and
 * a move to SQLite later is a read-all-and-insert, not a rewrite.
 */
import type { RunOutcome, RunRecord, RunStage } from '../pipeline/run.js';

export const OPS_HISTORY_SCHEMA_VERSION = 1;

/** One run, one line. */
export interface OpsRunRecord {
  /** Schema version, so an old file can be migrated forward rather than discarded. */
  v: number;
  id: string;
  pipeline: string;
  outcome: RunOutcome;
  stage?: RunStage;
  reason?: string;
  startedAt: number;
  durationMs: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
  failedOver?: boolean;
  lowConfidence?: boolean;
  dropped?: string[];
  reviewUrl?: string;
}

/** A day's worth, summed. */
export interface OpsDailyTotals {
  /** `YYYY-MM-DD`, local time — the operator's day, not UTC's. */
  date: string;
  runs: number;
  /** Runs per outcome. Only the outcomes that occurred appear. */
  byOutcome: Partial<Record<RunOutcome, number>>;
  tokens: number;
  costUsd: number;
  /** Runs where a second provider had to answer. */
  failedOver: number;
  /** Runs whose answer came back under the threshold, however they then ended. */
  lowConfidence: number;
  /** Runs that failed at some step. Skips and holds are not failures. */
  failed: number;
}

export interface OpsHistoryQuery {
  /** How many days back, today included. Default 7. */
  days?: number;
  pipeline?: string;
  outcome?: RunOutcome;
  /** Most recent first, capped. */
  limit?: number;
}

/** Today's numbers for one pipeline, which is what a dashboard row shows. */
export interface OpsPipelineCounts {
  runs: number;
  failed: number;
  lowConfidence: number;
  tokens: number;
}

export interface OpsHistoryStore {
  /** Record a finished run. */
  append(record: RunRecord): Promise<void>;
  /** Recent runs, newest first. */
  list(query?: OpsHistoryQuery): Promise<OpsRunRecord[]>;
  /** Per-day summaries, newest day first. */
  totals(days?: number): Promise<OpsDailyTotals[]>;
  /**
   * Runs grouped by pipeline over the last `days`.
   *
   * Grouped here rather than on the client: at operational volume a day is thousands of
   * runs, and shipping all of them so a dashboard can count them would make the list
   * heavier the busier the system gets — exactly backwards.
   */
  countsByPipeline(days?: number): Promise<Record<string, OpsPipelineCounts>>;
  /** Drop anything past the retention window. Returns how many files went. */
  prune(): Promise<number>;
}

/** Outcomes that mean something went wrong, as opposed to deliberately not happening. */
export const FAILURE_OUTCOMES: readonly RunOutcome[] = [
  'input_failed',
  'agent_failed',
  'rejected',
  'output_failed',
];

/** `YYYY-MM-DD` in local time. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Sum a day's records. The single definition of what a total means — the stored file and
 *  a rebuild from the log both go through here, so they cannot disagree. */
export function summarize(date: string, records: OpsRunRecord[]): OpsDailyTotals {
  const totals: OpsDailyTotals = {
    date,
    runs: records.length,
    byOutcome: {},
    tokens: 0,
    costUsd: 0,
    failedOver: 0,
    lowConfidence: 0,
    failed: 0,
  };
  for (const r of records) {
    totals.byOutcome[r.outcome] = (totals.byOutcome[r.outcome] ?? 0) + 1;
    totals.tokens += r.tokens ?? 0;
    totals.costUsd += r.costUsd ?? 0;
    if (r.failedOver) totals.failedOver++;
    if (r.lowConfidence) totals.lowConfidence++;
    if (FAILURE_OUTCOMES.includes(r.outcome)) totals.failed++;
  }
  // Float addition drifts; money shown to a person shouldn't read 0.30000000000000004.
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return totals;
}
