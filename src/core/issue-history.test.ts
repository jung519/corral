import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HistoryRecord, HISTORY_SCHEMA_VERSION, JsonlHistoryStore } from './issue-history.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-hist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(identifier: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    v: HISTORY_SCHEMA_VERSION,
    identifier,
    trackerKind: 'notion',
    repoKeys: ['app'],
    backend: 'docker',
    outcome: 'completed',
    prs: [],
    startedAt: 1000,
    endedAt: 2000,
    wallMs: 1000,
    agentActiveMs: 500,
    humanWaitMs: 300,
    setupMs: 100,
    dispatches: 3,
    phases: [],
    costUsd: 1.23,
    inputTokens: 10,
    outputTokens: 20,
    models: { planning: 'opus', implementation: 'sonnet', review: 'opus' },
    agentProvider: 'claude',
    ...over,
  };
}

describe('JsonlHistoryStore', () => {
  it('appends and reads back across instances', () => {
    new JsonlHistoryStore(dir).append(rec('MASIL-1'));
    const all = new JsonlHistoryStore(dir).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.identifier).toBe('MASIL-1');
    expect(all[0]?.agentActiveMs).toBe(500);
  });

  it('lists newest-first and filters by outcome', () => {
    const s = new JsonlHistoryStore(dir);
    s.append(rec('A', { endedAt: 100 }));
    s.append(rec('B', { endedAt: 300, outcome: 'failed' }));
    s.append(rec('C', { endedAt: 200, outcome: 'removed' }));
    expect(s.list().map((r) => r.identifier)).toEqual(['B', 'C', 'A']);
    expect(s.list({ outcome: 'failed' }).map((r) => r.identifier)).toEqual(['B']);
    expect(s.list({ limit: 2 }).map((r) => r.identifier)).toEqual(['B', 'C']);
    expect(s.list({ limit: 2, offset: 1 }).map((r) => r.identifier)).toEqual(['C', 'A']);
  });

  it('get() returns the most recent record for a re-run identifier', () => {
    const s = new JsonlHistoryStore(dir);
    s.append(rec('MASIL-9', { endedAt: 100, costUsd: 1 }));
    s.append(rec('MASIL-9', { endedAt: 500, costUsd: 9 }));
    expect(s.get('MASIL-9')?.costUsd).toBe(9);
    expect(s.get('absent')).toBeUndefined();
  });

  it('skips a corrupt line but keeps the rest', () => {
    const s = new JsonlHistoryStore(dir);
    s.append(rec('GOOD'));
    appendFileSync(join(dir, 'history.jsonl'), '{ this is not json\n'); // a torn write
    s.append(rec('GOOD2'));
    expect(
      s
        .all()
        .map((r) => r.identifier)
        .sort(),
    ).toEqual(['GOOD', 'GOOD2']);
  });

  it('returns empty when no history file exists', () => {
    expect(new JsonlHistoryStore(dir).all()).toEqual([]);
    expect(new JsonlHistoryStore(dir).list()).toEqual([]);
  });
});
