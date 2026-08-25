/**
 * The layer that separates "the agent said it did the work" from "the work is there".
 *
 * The measured failure it answers: a 4.35M-token implementation turn that wrote everything
 * and committed nothing, reported as `code=0` (CRL-89). The tick would have said done.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isUnbacked, taskEvidence } from './task-evidence.js';

const A = 'aaaaaaaa1111111111111111111111111111aaaa';
const B = 'bbbbbbbb2222222222222222222222222222bbbb';

describe('a ticked task', () => {
  it('is fine when a repository moved', () => {
    const e = taskEvidence('T1', true, { app: A }, { app: B });
    expect(isUnbacked(e)).toBe(false);
    expect(e.changed).toEqual(['app']);
  });

  /**
   * The whole point. `.corral/` is outside the repos, so ticking `tasks.md` cannot itself
   * produce a commit — an unmoved HEAD really does mean no work landed.
   */
  it('is caught when nothing moved', () => {
    const e = taskEvidence('T3', true, { app: A }, { app: A });
    expect(isUnbacked(e)).toBe(true);
    expect(e.changed).toEqual([]);
  });

  it('is fine when any one of several repositories moved', () => {
    const e = taskEvidence('T2', true, { app: A, server: A }, { app: A, server: B });
    expect(isUnbacked(e)).toBe(false);
    expect(e.changed).toEqual(['server']);
  });
});

describe('an unticked task', () => {
  // The loop's "no progress" check already covers this; reporting it here too would raise
  // two events for one situation (CRL-106).
  it.each([
    ['with a commit', B],
    ['without one', A],
  ])('is not this check\'s business %s', (_label, after) => {
    expect(isUnbacked(taskEvidence('T1', false, { app: A }, { app: after }))).toBe(false);
  });
});

describe('when git will not answer', () => {
  /**
   * Not knowing is not evidence of absence. A verdict built on a failed `git` call is the
   * false positive that would make the whole layer untrustworthy — and the acceptance
   * criterion asks that a false positive be explainable.
   */
  it('does not accuse a task when no head could be read', () => {
    const e = taskEvidence('T1', true, { app: null }, { app: null });
    expect(isUnbacked(e)).toBe(false);
    expect(e.detail).toBe('no repository could be read');
  });

  it('leaves an unreadable repo out rather than counting it as unchanged', () => {
    // `server` is unknown on one side; `app` moved, so the task is backed.
    const e = taskEvidence('T1', true, { app: A, server: null }, { app: B, server: B });
    expect(isUnbacked(e)).toBe(false);
    expect(e.detail).not.toContain('server');
  });

  it('ignores a repo that disappeared mid-turn', () => {
    const e = taskEvidence('T1', true, { app: A }, { app: null });
    expect(isUnbacked(e)).toBe(false);
  });
});

describe('the evidence it leaves', () => {
  it('names each repo with the commit either side, so a person can go and look', () => {
    // Acceptance criterion: when this is a false positive, it must be possible to see why.
    const e = taskEvidence('T1', true, { app: A, server: A }, { app: A, server: A });
    expect(e.detail).toBe('app: aaaaaaaa → aaaaaaaa, server: aaaaaaaa → aaaaaaaa');
  });
});

/**
 * The bracketing lives in the orchestrator, which has no test harness, so it is checked by
 * reading — the technique `ops/boundaries.test.ts` uses for the import wall.
 */
describe('the loop, read from the source', () => {
  const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

  it('captures heads either side of the task turn', () => {
    const run = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf("case 'run': {"), ORCHESTRATOR.indexOf('state.lastTaskId'));
    const before = run.indexOf('const before = await this.repoHeads(handle)');
    const dispatch = run.indexOf('taskPrompt(');
    const after = run.indexOf('const after = await this.repoHeads(handle)');
    expect(before).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(dispatch);
  });

  it('re-reads the tick from the file rather than assuming the turn ticked it', () => {
    expect(ORCHESTRATOR).toMatch(/const claimed = ticked\?\.tasks\.find\(\(t\) => t\.id === task\.id\)\?\.done \?\? false;/);
  });

  it('reports rather than halting', () => {
    // A task can legitimately need no change — already done, or covered in passing by an
    // earlier one. Stopping the run on that repeats the mistake CRL-105 avoided.
    const run = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('if (isUnbacked(evidence))'), ORCHESTRATOR.indexOf('state.lastTaskId'));
    expect(run).toContain('unbacked.push(evidence)');
    expect(run).not.toContain('surfaceStuck');
    expect(run).not.toContain('return true');
  });

  it('says it again before the run moves on to review', () => {
    // The per-task notice scrolls away during a long implementation; this is the last point
    // a person sees it before a PR is proposed.
    const done = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf("case 'done':"), ORCHESTRATOR.indexOf('return true;', ORCHESTRATOR.indexOf("case 'done':")));
    expect(done).toMatch(/if \(unbacked\.length > 0\)/);
    expect(done.indexOf('unbacked.length')).toBeLessThan(done.indexOf('reviewAfterImplement'));
  });

  it('reads a head per repo without throwing', () => {
    const fn = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('private async repoHeads'));
    expect(fn.slice(0, 700)).toContain('rev-parse HEAD');
    expect(fn.slice(0, 700)).toMatch(/catch \{[\s\S]{0,80}= null;/);
  });
});
