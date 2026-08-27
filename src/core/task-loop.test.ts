/**
 * The loop's judgement, tested where it can be: as a function.
 *
 * Three of these guard against the run *looking* fine while going wrong — a stalled task
 * bought over and over, a cycle read as completion, an unreadable file silently doing
 * nothing. Those are the failures a progress bar hides.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSpecTasks } from './spec-tasks.js';
import { nextTaskStep, type TaskLoopState } from './task-loop.js';

const REAL = readFileSync(new URL('./__fixtures__/tasks-crl90.md', import.meta.url), 'utf8');
const fresh = (): TaskLoopState => ({ rounds: 0 });
const list = (...lines: string[]) => parseSpecTasks(['# Tasks', '', ...lines].join('\n'));

describe('working through a real task list', () => {
  it('starts at the first task', () => {
    const step = nextTaskStep(parseSpecTasks(REAL), fresh(), 20);
    expect(step).toEqual({ kind: 'run', taskId: 'T1', position: 1, total: 5 });
  });

  /**
   * The position comes from the file's own tick count, not from a counter the loop keeps.
   * That is what makes a restart mid-list land in the right place.
   */
  it('picks up mid-list from the ticks alone, with no memory of earlier rounds', () => {
    const partly = REAL.replace('- [ ] T1', '- [x] T1').replace('- [ ] T2', '- [x] T2');
    const step = nextTaskStep(parseSpecTasks(partly), fresh(), 20);
    expect(step).toEqual({ kind: 'run', taskId: 'T3', position: 3, total: 5 });
  });

  it('goes to review once every task is ticked', () => {
    const all = REAL.replace(/- \[ \]/g, '- [x]');
    expect(nextTaskStep(parseSpecTasks(all), fresh(), 20)).toEqual({ kind: 'done' });
  });
});

describe('when the run stops making progress', () => {
  /**
   * The agent ticks its own line. If it does not — it stopped early, or wrote the file
   * wrongly — the parser keeps handing back the same task and the loop would buy that same
   * turn for ever. The measured cost of one implementation turn was $3.78 (CRL-89).
   */
  it('stops after a task fails to complete, instead of buying it again', () => {
    const tasks = list('- [ ] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)');
    const step = nextTaskStep(tasks, { lastTaskId: 'T1', rounds: 1 }, 20);
    expect(step.kind).toBe('halt');
    expect((step as { reason: string }).reason).toMatch(/T1 did not complete/);
  });

  it('carries on when the previous task did complete', () => {
    const tasks = list('- [x] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)');
    expect(nextTaskStep(tasks, { lastTaskId: 'T1', rounds: 1 }, 20)).toMatchObject({ kind: 'run', taskId: 'T2' });
  });

  /**
   * A cycle leaves work undone with nothing runnable. Reported as a halt, never as `done`
   * — CRL-105 separated the two signals for this exact reading.
   */
  it('halts on a dependency cycle rather than calling it finished', () => {
    const tasks = list('- [ ] T1 — one (REQ-1) [after: T2]', '- [ ] T2 — two (REQ-2) [after: T1]');
    const step = nextTaskStep(tasks, fresh(), 20);
    expect(step.kind).toBe('halt');
    expect((step as { reason: string }).reason).toMatch(/waiting on another/);
  });

  it('stops at the ceiling and says how much is left', () => {
    const tasks = list('- [x] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)', '- [ ] T3 — three (REQ-3)');
    const step = nextTaskStep(tasks, { lastTaskId: 'T1', rounds: 3 }, 3);
    expect(step.kind).toBe('halt');
    expect((step as { reason: string }).reason).toMatch(/2 still open/);
  });

  it('does not stop at the ceiling when the work is already finished', () => {
    // Reaching the limit on the turn that completes the list is success, not a stall.
    const tasks = list('- [x] T1 — one (REQ-1)');
    expect(nextTaskStep(tasks, { lastTaskId: 'T1', rounds: 99 }, 3)).toEqual({ kind: 'done' });
  });
});

describe('when there is no task list', () => {
  // The plan doc's mitigation for a format drift: fall back to the single implementation
  // dispatch rather than refusing to implement anything.
  it('asks the caller to downgrade', () => {
    const step = nextTaskStep(null, fresh(), 20);
    expect(step).toEqual({ kind: 'downgrade', reason: 'no readable task list' });
  });

  it('downgrades rather than halting — the issue still gets implemented', () => {
    expect(nextTaskStep(parseSpecTasks('# Tasks\n\njust prose'), fresh(), 20).kind).toBe('downgrade');
  });
});

/**
 * The loop lives in the orchestrator, whose constructor takes eleven collaborators, so the
 * wiring is checked by reading it — the technique `ops/boundaries.test.ts` uses for the
 * import wall.
 */
describe('the loop, read from the source', () => {
  const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

  it('only runs in spec mode, and leaves the single path reachable', () => {
    expect(ORCHESTRATOR).toMatch(/spec_mode === 'split' && \(await this\.runTaskLoop\(rt, issue\)\)/);
    // `runTaskLoop` returning false is what falls through to this.
    expect(ORCHESTRATOR).toContain('this.planApprovalPrompt(detail)');
  });

  it('re-reads the file every round instead of tracking progress in memory', () => {
    // The whole basis of "a restart resumes from the remaining tasks" — there is no state
    // to lose, so a restart just reads the ticks that are already there.
    expect(ORCHESTRATOR).toMatch(/for \(;;\) \{[\s\S]{0,200}parseSpecTasks\(await this\.workspace\.io\.readFile\(handle, SPEC\.tasks\)\)/);
  });

  it('enters the same loop on a restart', () => {
    const resume = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('private async resumeImplementing'));
    expect(resume.slice(0, 900)).toMatch(/runTaskLoop\(rt, issue\)/);
  });

  it('never declares a spec document as the task turn\'s output', () => {
    // Each task reads the same three documents; a turn that cleared them would take the
    // next task's input with it (CRL-88).
    const flat = ORCHESTRATOR.replace(/\s+/g, ' ');
    const calls = [...flat.matchAll(/this\.dispatch\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0]);
    const taskCall = calls.find((c) => c.includes('taskPrompt'));
    expect(taskCall, 'no dispatch found for taskPrompt').toBeDefined();
    expect(taskCall).not.toContain('SPEC.');
  });

  it('surfaces the parser warnings once each, not every round', () => {
    // The same warning per turn would bury the events that matter; none at all would show a
    // clean progress count over a partly unreadable file (CRL-105).
    expect(ORCHESTRATOR).toMatch(/if \(announced\.has\(w\)\) continue;/);
  });
});
