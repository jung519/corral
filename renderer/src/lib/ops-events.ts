/**
 * Which bus events belong on the operational timeline.
 *
 * One bus carries both pillars, so the ops screen has to pick. It used to take `kind: 'run'`
 * and nothing else — but a run emits three events, and the middle one is the only sign that
 * anything is happening:
 *
 *     run started          kind: 'run'
 *     calling the model    kind: 'phase'   ← dropped
 *     run completed        kind: 'run'
 *
 * So a run that takes ten seconds rendered as a result appearing out of nothing, and the
 * screen looked like a log of outcomes rather than a thing in motion (CRL-137).
 *
 * The development side puts its own `phase` events on the same bus, and those belong to the
 * issue dashboard. What separates them is `data.pipeline`, which the pipeline runner attaches
 * to everything it emits and nothing else does.
 */
import type { CorralEvent } from './types';

export function isOpsEvent(e: Pick<CorralEvent, 'kind' | 'data'>): boolean {
  if (e.kind === 'run') return true;
  return e.kind === 'phase' && e.data?.pipeline !== undefined;
}

/**
 * Whether this event changes what the counts say.
 *
 * Only a finished run does. Refreshing on the others would be a round trip for the same
 * numbers, once per event, on a screen that already polls.
 */
export function changesCounts(e: Pick<CorralEvent, 'kind'>): boolean {
  return e.kind === 'run';
}
