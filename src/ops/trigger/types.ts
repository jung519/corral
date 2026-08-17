/**
 * The trigger axis — how work arrives.
 *
 * The sixth adapter axis, following the same shape as the five the development AI uses:
 * an interface, a registry keyed by the definition's `kind`, and reference
 * implementations that register themselves at startup. Adding a way for work to arrive
 * should be one adapter and one schema variant, not a change to the runtime.
 *
 * A trigger's only job is to say "here is one piece of work". It does not decide whether
 * to run it, what the limits are, or what to do when it fails — the lifecycle owns all of
 * that, and a trigger that made those decisions itself would have to be trusted to make
 * them the same way every other trigger does.
 */
import type { BudgetVerdict } from '../../core/token-budget.js';
import type { Pipeline } from '../pipeline/schema.js';
import type { RunRecord } from '../pipeline/run.js';

/** Hand one event to the lifecycle and learn how it went. */
export type FireFn = (event: unknown) => Promise<RunRecord | undefined>;

/** A running subscription. Calling it must be safe more than once. */
export type StopFn = () => void | Promise<void>;

export interface TriggerAdapter {
  readonly kind: string;
  /**
   * Begin delivering work. Returns the stop handle.
   *
   * Whatever this sets up — a timer, a queue subscription — has to be released by the
   * returned function: an operator disabling a pipeline expects it to go quiet, and a
   * timer that outlives its pipeline is a run nobody asked for.
   */
  start(pipeline: Pipeline, fire: FireFn): StopFn;
}

export interface TriggerContext {
  /** Injectable clock/timer, so schedules can be tested without waiting for a minute. */
  now?: () => number;
  /**
   * Whether the day's shared ceiling has anything left.
   *
   * Read-only, and `check` only: a trigger never records usage — that is the lifecycle's,
   * which is the one place that knows what a turn actually cost.
   *
   * This does not make a trigger a decision-maker. "Should this run" is still the
   * lifecycle's answer and every trigger gets the same one. What a trigger decides is
   * narrower and its own: **whether to take work out of wherever it is waiting.** A queue
   * that keeps handing over messages nothing can run turns a spent budget into lost work
   * (CRL-49), and no amount of correctness downstream can undo that.
   */
  budget?: { check(): BudgetVerdict };
}
