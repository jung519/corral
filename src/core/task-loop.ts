/**
 * Deciding what the task loop does next.
 *
 * The loop itself lives in the orchestrator, which has no test harness — so the judgement
 * is here, as a function over the parsed task list, and the orchestrator does what it says.
 *
 * The progress is not held in memory. `tasks.md` is the record: the agent ticks a line as
 * it commits, and every round re-reads the file. That is what makes a restart resume by
 * itself rather than by remembering — there is nothing to remember (CRL-106).
 */
import type { SpecTaskList } from './spec-tasks.js';

export type TaskStep =
  /** Run this task. `position`/`total` are for the prompt and the progress event. */
  | { kind: 'run'; taskId: string; position: number; total: number }
  /** Every task is ticked — go to review. */
  | { kind: 'done' }
  /** No readable task list: fall back to the single implementation dispatch (plan §13). */
  | { kind: 'downgrade'; reason: string }
  /** Stop and tell the human. Nothing here resolves by trying again. */
  | { kind: 'halt'; reason: string };

export interface TaskLoopState {
  /** The task the previous round was told to do, if any. */
  lastTaskId?: string;
  /** Dispatches spent so far — bounded so a malformed list cannot spin. */
  rounds: number;
}

/**
 * What to do next, given the current file and what the last round did.
 *
 * `maxRounds` bounds the loop. The count is dispatches, not tasks: a list of five tasks
 * costs five implementation turns, and a file that somehow describes a hundred would
 * otherwise buy a hundred.
 */
export function nextTaskStep(tasks: SpecTaskList | null, state: TaskLoopState, maxRounds: number): TaskStep {
  if (!tasks) return { kind: 'downgrade', reason: 'no readable task list' };

  if (tasks.blocked) {
    // CRL-105 separates this from "nothing left" precisely so it cannot be mistaken for
    // completion here.
    return { kind: 'halt', reason: `${tasks.total - tasks.done} task(s) remain but each is waiting on another (dependency cycle)` };
  }

  if (!tasks.next) return { kind: 'done' };

  /**
   * The agent ticks its own line. When it does not — it stopped early, or wrote the file
   * wrongly — the parser hands back the same `next` and the loop would buy that same task
   * for ever. One repeat is the signal.
   */
  if (state.lastTaskId === tasks.next.id) {
    return {
      kind: 'halt',
      reason: `${tasks.next.id} did not complete — it is still unticked after a full turn, so the run is not progressing`,
    };
  }

  if (state.rounds >= maxRounds) {
    return {
      kind: 'halt',
      reason: `stopped after ${maxRounds} task turn(s) with ${tasks.total - tasks.done} still open — raise the limit or finish the rest by hand`,
    };
  }

  return { kind: 'run', taskId: tasks.next.id, position: tasks.done + 1, total: tasks.total };
}
