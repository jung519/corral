/**
 * Reading `.corral/spec/tasks.md`.
 *
 * The task list is the one spec document written to be read by code as well as by people:
 * it is what turns `implementing` from a black box into a count, and what lets a restart
 * pick up from the task after the last one committed instead of offering a Retry button.
 *
 * Everything here is shaped by an actual file an agent produced (CRL-103), not by the
 * grammar in the abstract. Three things came out of that:
 *
 * - **Task text contains parentheses.** One line read `Add describe('reviewing') …
 *   (REQ-2, REQ-6)`. A parser that scans forward for a bracket picks up the wrong one, so
 *   the requirement list is anchored at the end of the line instead.
 * - **The file has a heading and blank lines.** Only checkbox lines are tasks.
 * - **A task cites several requirements** — four, in that file.
 *
 * Nothing throws. The plan doc's mitigation for "the parser breaks on a format drift" is a
 * safe downgrade to the single-plan flow, and that only works if the caller is handed a
 * verdict rather than an exception.
 */

export interface SpecTask {
  /** `T1`, `T2`, … as written. */
  id: string;
  /** What the task does — the prose between the id and the requirement list. */
  title: string;
  /** Requirement ids this task serves, in the order written. */
  requires: string[];
  /** Task ids that must finish first. Empty when the task can start immediately. */
  after: string[];
  /** The checkbox is ticked. */
  done: boolean;
  /** 1-based line in the file, so a warning can point at something. */
  line: number;
}

export interface SpecTaskList {
  tasks: SpecTask[];
  done: number;
  total: number;
  /** The task to work next: the first undone one whose dependencies are all done. */
  next: SpecTask | null;
  /**
   * Work remains but nothing can start — a dependency cycle.
   *
   * Distinguished from `next: null` with nothing left, because the two look identical to a
   * caller that only checks for a next task, and one of them means "finished" while the
   * other means "stuck".
   */
  blocked: boolean;
  /** Lines that could not be read, and inconsistencies that did not stop the parse. */
  warnings: string[];
}

/**
 * `- [ ] T1 — does a thing (REQ-1, REQ-3) [after: T0, T2]`
 *
 * The requirement list is pinned to the end (optionally followed by `[after: …]`) so that
 * brackets inside the title cannot be mistaken for it. `[Xx]` because the file is also
 * hand-editable and a person will type a capital.
 */
const TASK_LINE =
  /^\s*-\s*\[([ xX])\]\s*(T\d+)\s*[—–-]\s*(.+?)\s*\(((?:REQ-\d+)(?:\s*,\s*REQ-\d+)*)\)\s*(?:\[after:\s*([^\]]*)\])?\s*$/;

/** A checkbox line — anything shaped like a task, whether or not it parses. */
const CHECKBOX_LINE = /^\s*-\s*\[[ xX]\]/;

/**
 * Parse the document.
 *
 * Returns `null` when not a single task could be read — the signal to fall back to the
 * single-plan flow. A partially readable file comes back as what was read *plus* the lines
 * that were not: dropping them silently would show 3/3 complete on a file that describes
 * five pieces of work.
 */
export function parseSpecTasks(markdown: string | null): SpecTaskList | null {
  if (!markdown?.trim()) return null;

  const tasks: SpecTask[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  markdown.split('\n').forEach((raw, i) => {
    if (!CHECKBOX_LINE.test(raw)) return; // headings, prose, blank lines
    const line = i + 1;
    const m = TASK_LINE.exec(raw);
    if (!m) {
      warnings.push(`line ${line}: not a task line — ${raw.trim().slice(0, 80)}`);
      return;
    }
    const [, box, id, title, reqs, after] = m;
    if (seen.has(id!)) {
      // Kept rather than dropped: the work is real even when the label is wrong. The first
      // one wins for dependency purposes, which the warning says out loud.
      warnings.push(`line ${line}: duplicate task id ${id} — dependencies will use the first`);
    }
    seen.add(id!);
    tasks.push({
      id: id!,
      title: title!.trim(),
      requires: reqs!.split(',').map((r) => r.trim()),
      after: (after ?? '')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      done: box !== ' ',
      line,
    });
  });

  if (tasks.length === 0) return null;

  const byId = new Map<string, SpecTask>();
  for (const t of tasks) if (!byId.has(t.id)) byId.set(t.id, t);

  // An `[after: T9]` pointing at nothing is a typo, and a typo must not stop the run —
  // treated as satisfied, and said out loud so it can be fixed.
  const satisfied = (t: SpecTask) =>
    t.after.every((d) => {
      const dep = byId.get(d);
      if (!dep) return true;
      return dep.done;
    });
  for (const t of tasks) {
    for (const d of t.after) {
      if (!byId.has(d)) warnings.push(`line ${t.line}: ${t.id} depends on ${d}, which is not in this file`);
    }
  }

  const undone = tasks.filter((t) => !t.done);
  const next = undone.find(satisfied) ?? null;
  const blocked = undone.length > 0 && next === null;
  if (blocked) warnings.push('every remaining task is waiting on another — the dependencies form a cycle');

  return {
    tasks,
    done: tasks.length - undone.length,
    total: tasks.length,
    next,
    blocked,
    warnings,
  };
}
