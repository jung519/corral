/**
 * The first test is the real one: a `tasks.md` an agent actually wrote (CRL-103's
 * measurement run, kept verbatim in `__fixtures__`). Everything after it covers the ways a
 * file can be wrong, because the plan doc's mitigation for "the parser breaks on a format
 * drift" is a safe downgrade — which only works if this never throws.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSpecTasks } from './spec-tasks.js';

const REAL = readFileSync(new URL('./__fixtures__/tasks-crl90.md', import.meta.url), 'utf8');

describe('a task list an agent actually produced', () => {
  const parsed = parseSpecTasks(REAL)!;

  it('reads every task, and reads nothing else', () => {
    expect(parsed).not.toBeNull();
    expect(parsed.total).toBe(5);
    expect(parsed.warnings).toEqual([]); // the heading line is not a warning
    expect(parsed.tasks.map((t) => t.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
  });

  /**
   * That line reads `Add describe('reviewing') cross-check assertions … (REQ-2, REQ-6)`.
   * Scanning forward for a bracket finds the wrong one; the requirement list is anchored at
   * the end of the line for exactly this.
   */
  it('is not fooled by brackets inside the task text', () => {
    const t4 = parsed.tasks.find((t) => t.id === 'T4')!;
    expect(t4.requires).toEqual(['REQ-2', 'REQ-6']);
    expect(t4.title).toContain("describe('reviewing')");
  });

  it('reads all four requirements when a task cites four', () => {
    expect(parsed.tasks[0]!.requires).toEqual(['REQ-1', 'REQ-5', 'REQ-6', 'REQ-7']);
  });

  it('reads the dependencies', () => {
    expect(parsed.tasks[0]!.after).toEqual([]);
    for (const id of ['T2', 'T3', 'T4', 'T5']) {
      expect(parsed.tasks.find((t) => t.id === id)!.after, id).toEqual(['T1']);
    }
  });

  it('starts at the first task, with nothing done', () => {
    expect(parsed.done).toBe(0);
    expect(parsed.next?.id).toBe('T1');
    expect(parsed.blocked).toBe(false);
  });
});

const list = (...lines: string[]) => parseSpecTasks(['# Tasks', '', ...lines].join('\n'));

describe('progress', () => {
  it('counts what is ticked', () => {
    const p = list('- [x] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)')!;
    expect([p.done, p.total]).toEqual([1, 2]);
  });

  it('accepts a capital X — the file is hand-editable too', () => {
    expect(list('- [X] T1 — one (REQ-1)')!.done).toBe(1);
  });
});

describe('the resume point', () => {
  it('is the first undone task', () => {
    const p = list('- [x] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)', '- [ ] T3 — three (REQ-3)')!;
    expect(p.next?.id).toBe('T2');
  });

  it('skips a task whose dependency is still open', () => {
    const p = list('- [ ] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2) [after: T1]')!;
    expect(p.next?.id).toBe('T1');
  });

  it('waits for every dependency in a list', () => {
    const p = list('- [x] T1 — one (REQ-1)', '- [ ] T2 — two (REQ-2)', '- [ ] T3 — three (REQ-3) [after: T1, T2]')!;
    expect(p.next?.id).toBe('T2');
  });

  it('is null when everything is done', () => {
    const p = list('- [x] T1 — one (REQ-1)')!;
    expect(p.next).toBeNull();
    expect(p.blocked).toBe(false);
  });

  /**
   * `next: null` with work remaining and `next: null` with nothing left look identical to a
   * caller that only checks for a next task — and one means finished while the other means
   * stuck. Hence the separate flag.
   */
  it('says it is blocked rather than quietly looking finished', () => {
    const p = list('- [ ] T1 — one (REQ-1) [after: T2]', '- [ ] T2 — two (REQ-2) [after: T1]')!;
    expect(p.next).toBeNull();
    expect(p.blocked).toBe(true);
    expect(p.warnings.join(' ')).toMatch(/cycle/);
  });

  it('does not let a typo in a dependency stop the run', () => {
    // `[after: T9]` where T9 does not exist. Refusing to proceed would strand the issue on
    // a single mistyped character.
    const p = list('- [ ] T1 — one (REQ-1) [after: T9]')!;
    expect(p.next?.id).toBe('T1');
    expect(p.warnings.join(' ')).toMatch(/T9, which is not in this file/);
  });
});

describe('a file that is not quite right', () => {
  it('keeps the lines it can read and reports the ones it cannot', () => {
    // Dropping the bad line silently would report 2/2 complete on a file describing three
    // pieces of work.
    const p = list('- [ ] T1 — one (REQ-1)', '- [ ] T2 no separator and no requirements', '- [ ] T3 — three (REQ-3)')!;
    expect(p.total).toBe(2);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/^line 4: not a task line/);
  });

  it('reports a duplicate id but keeps the work', () => {
    const p = list('- [ ] T1 — one (REQ-1)', '- [ ] T1 — also one (REQ-2)')!;
    expect(p.total).toBe(2);
    expect(p.warnings.join(' ')).toMatch(/duplicate task id T1/);
  });

  it('ignores headings, prose and blank lines', () => {
    const p = parseSpecTasks(['# Tasks', '', 'Some prose about the plan.', '', '- [ ] T1 — one (REQ-1)'].join('\n'))!;
    expect(p.total).toBe(1);
    expect(p.warnings).toEqual([]);
  });
});

describe('nothing readable at all', () => {
  // The signal for the caller to fall back to the single-plan flow.
  it.each([
    ['empty', ''],
    ['whitespace', '   \n\n  '],
    ['null', null],
    ['prose only', '# Tasks\n\nWe will do the thing, then the other thing.'],
    ['checkboxes that parse as nothing', '- [ ] do the thing\n- [x] do the other thing'],
  ])('returns null for %s', (_label, input) => {
    expect(parseSpecTasks(input)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['- [ ] T1 —', '- [] T1 — x (REQ-1)', '[after: T1]', '- [ ] T1 — x ()', ' ']) {
      expect(() => parseSpecTasks(input)).not.toThrow();
    }
  });
});
