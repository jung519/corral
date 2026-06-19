import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IssueStateStore } from './issue-state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('IssueStateStore', () => {
  it('upserts, reads, lists and deletes', () => {
    const store = new IssueStateStore(dir);
    store.upsert({ identifier: 'ISS-1', repoKey: 'main', phase: 'implementing' });
    expect(store.get('ISS-1')?.phase).toBe('implementing');
    expect(store.all()).toHaveLength(1);
    store.delete('ISS-1');
    expect(store.get('ISS-1')).toBeUndefined();
  });

  it('finds by approval id', () => {
    const store = new IssueStateStore(dir);
    store.upsert({ identifier: 'ISS-2', repoKey: 'main', phase: 'plan_sent', approvalId: 'appr-9' });
    expect(store.findByApprovalId('appr-9')?.identifier).toBe('ISS-2');
  });

  it('persists across instances (restart recovery)', () => {
    new IssueStateStore(dir).upsert({ identifier: 'ISS-3', repoKey: 'main', phase: 'pr_open' });
    const reloaded = new IssueStateStore(dir);
    expect(reloaded.get('ISS-3')?.phase).toBe('pr_open');
  });
});
