/**
 * Append-only issue history — a tracker-independent audit log of every issue the
 * orchestrator ran to a terminal state (completed / removed / failed). The live
 * IssueStateStore deletes an issue once it finishes; this store is where the record
 * outlives that cleanup. Tracker metadata (title, url, kind) is SNAPSHOTTED at write
 * time so the history survives swapping or disconnecting the tracker.
 *
 * Stored as JSON Lines: appends are a single write and one corrupt line never loses
 * the rest. The store is an interface so the backend can later move to SQLite/Postgres
 * without touching call sites — migrate by reading all() and bulk-inserting; the `v`
 * field carries the schema version for forward migration.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { QaEntry } from './issue-state.js';
import { logger } from './logger.js';

export const HISTORY_SCHEMA_VERSION = 1;

export type IssueOutcome = 'completed' | 'removed' | 'failed';

export interface HistoryPr {
  repoKey: string;
  number: number;
  url?: string;
  merged?: boolean;
}

/** One phase the issue passed through, with how long it stayed there. */
export interface HistoryPhase {
  phase: string;
  at: number; // epoch ms the phase was entered
  durationMs: number; // until the next phase (or end)
}

export interface HistoryRecord {
  /** Schema version (forward migration). */
  v: number;
  identifier: string;
  /** Tracker snapshot — preserved even if the tracker is later swapped/removed. */
  title?: string;
  url?: string;
  trackerKind: string;
  repoKeys: string[];
  backend: 'local' | 'docker';
  outcome: IssueOutcome;
  prs: HistoryPr[];

  // ── timing (epoch ms / durations in ms) ──
  startedAt: number;
  endedAt: number;
  wallMs: number; // ended - started (total wall clock)
  agentActiveMs: number; // sum of agent dispatch durations (real AI work)
  humanWaitMs: number; // sum of approval-pending intervals
  setupMs: number; // start → first planning dispatch (image build + clone)
  dispatches: number;
  phases: HistoryPhase[];

  // ── cost ──
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  models: { planning: string; implementation: string; review: string };
  agentProvider: string; // provider that actually ran (after any failover)
  failoverUsed?: boolean;

  /** Read-only Q&A the human had with the agent about the plan/review (if any). */
  qa?: QaEntry[];
}

export interface HistoryListOpts {
  limit?: number;
  offset?: number;
  outcome?: IssueOutcome;
}

/**
 * Backend-agnostic history store. JsonlHistoryStore is the file-backed default; a
 * future SqliteHistoryStore can implement the same interface so the orchestrator and
 * server never change. (A network DB would widen these to Promise — every call site
 * is already in an async context.)
 */
export interface IssueHistoryStore {
  append(record: HistoryRecord): void;
  list(opts?: HistoryListOpts): HistoryRecord[];
  /** Most recent record for an identifier (an id can be re-run). */
  get(identifier: string): HistoryRecord | undefined;
  all(): HistoryRecord[];
}

export class JsonlHistoryStore implements IssueHistoryStore {
  private readonly stateDir: string;
  private readonly file: string;

  constructor(stateDir: string = process.env.CORRAL_STATE_DIR ?? '.corral-state') {
    this.stateDir = stateDir;
    this.file = resolve(stateDir, 'history.jsonl');
  }

  append(record: HistoryRecord): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    } catch (err) {
      logger.warn('history append failed', String(err));
    }
  }

  all(): HistoryRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return []; // no history yet
    }
    const out: HistoryRecord[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s) as HistoryRecord);
      } catch {
        /* skip a corrupt line, keep the rest */
      }
    }
    return out;
  }

  list(opts: HistoryListOpts = {}): HistoryRecord[] {
    let rows = this.all().sort((a, b) => b.endedAt - a.endedAt); // newest first
    if (opts.outcome) rows = rows.filter((r) => r.outcome === opts.outcome);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  get(identifier: string): HistoryRecord | undefined {
    return this.all()
      .filter((r) => r.identifier === identifier)
      .sort((a, b) => b.endedAt - a.endedAt)[0];
  }
}
