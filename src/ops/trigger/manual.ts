/**
 * Work arrives because a person asked.
 *
 * There is nothing to subscribe to: the run comes in through the control plane's `opsRun`
 * and goes straight to the lifecycle. This adapter exists so `manual` is a kind like any
 * other rather than a special case in the runtime — the registry answers for it, the
 * dashboard lists it, and nothing has to ask "unless it's manual".
 *
 * A pipeline with no automatic trigger is a normal thing to want: something you run to
 * reprocess a failure, or to try a prompt out before pointing a queue at it.
 */
import type { Pipeline } from '../pipeline/schema.js';
import type { FireFn, ReportFn, StopFn, TriggerAdapter, TriggerContext } from './types.js';

export class ManualTrigger implements TriggerAdapter {
  readonly kind = 'manual' as const;

  constructor(_ctx: TriggerContext = {}) {}

  start(_pipeline: Pipeline, _fire: FireFn, report?: ReportFn): StopFn {
    // Nothing to attach to and nothing that can stop working: a manual pipeline is run by
    // somebody pressing a button. Said out loud anyway, because a trigger that reports
    // nothing looks the same as one that has not got round to it yet.
    report?.({ state: 'attached' });
    return () => {};
  }
}
