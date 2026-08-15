/**
 * Run a pipeline on a cron schedule.
 *
 * Ticks once a minute and asks whether this is a minute the expression names. A minute is
 * cron's own resolution, so nothing finer is being given up — and a timer that wakes 60
 * times an hour costs nothing next to the work it triggers.
 *
 * Each firing is remembered by the minute it belongs to, so a tick that lands twice in the
 * same minute (timer drift, a clock nudged backwards) does not run the pipeline twice.
 */
import { logger } from '../../core/logger.js';
import type { Pipeline } from '../pipeline/schema.js';
import { cronMatches, parseCron, type CronFields } from './cron.js';
import type { FireFn, StopFn, TriggerAdapter, TriggerContext } from './types.js';

const TICK_MS = 60_000;

export class ScheduleTrigger implements TriggerAdapter {
  readonly kind = 'schedule' as const;

  constructor(private readonly ctx: TriggerContext = {}) {}

  start(pipeline: Pipeline, fire: FireFn): StopFn {
    if (pipeline.trigger.kind !== 'schedule') throw new Error('ScheduleTrigger given a non-schedule trigger');
    const { cron } = pipeline.trigger;

    let fields: CronFields;
    try {
      fields = parseCron(cron);
    } catch (err) {
      // A schedule nobody can read is a pipeline that silently never runs. Say so once,
      // loudly, and stay stopped rather than firing at some guessed interval.
      logger.error(`ops: pipeline "${pipeline.key}" has an unusable schedule "${cron}" — ${message(err)}`);
      return () => {};
    }

    const now = this.ctx.now ?? (() => Date.now());
    let lastFired = '';
    let running = false;

    const tick = (): void => {
      const at = new Date(now());
      if (!cronMatches(fields, at)) return;

      const minute = `${at.toDateString()} ${at.getHours()}:${at.getMinutes()}`;
      if (minute === lastFired) return; // already fired for this minute
      lastFired = minute;

      // A schedule that fires while the previous run is still going would stack up work
      // the concurrency limit would only throttle later; skipping is the honest answer
      // for a periodic job that has fallen behind.
      if (running) {
        logger.warn(`ops: pipeline "${pipeline.key}" skipped a scheduled run — the previous one is still going`);
        return;
      }
      running = true;
      void fire({ scheduledAt: at.toISOString(), pipeline: pipeline.key })
        .catch((err: unknown) => logger.warn(`ops: scheduled run of "${pipeline.key}" failed — ${message(err)}`))
        .finally(() => (running = false));
    };

    const timer = setInterval(tick, TICK_MS);
    // Never hold the process open for a timer; a core with nothing else to do should be
    // able to exit.
    timer.unref?.();
    logger.info(`ops: pipeline "${pipeline.key}" scheduled (${cron})`);

    return () => clearInterval(timer);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
