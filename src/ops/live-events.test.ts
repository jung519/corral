/**
 * What the operational timeline shows while a run is happening.
 *
 * The pipeline runner emits three events per run, and the screen took one kind of them:
 *
 *     run started          kind 'run'      shown
 *     calling the model    kind 'phase'    DROPPED
 *     run completed        kind 'run'      shown
 *
 * So a run rendered as a start and an end with nothing between — a log of outcomes rather
 * than a thing in motion. The middle event exists for exactly this and was thrown away
 * (CRL-137).
 *
 * The predicate lives in the renderer, which is a separate workspace outside this project's
 * `rootDir`; the specifier is computed for that reason, the same as `context-rows.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

type Ev = { kind: string; data?: Record<string, unknown> };
let isOpsEvent: (e: Ev) => boolean;
let changesCounts: (e: { kind: string }) => boolean;

beforeAll(async () => {
  const href = new URL('../../renderer/src/lib/ops-events.ts', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ href)) as {
    isOpsEvent: typeof isOpsEvent;
    changesCounts: typeof changesCounts;
  };
  isOpsEvent = mod.isOpsEvent;
  changesCounts = mod.changesCounts;
});

/** Exactly what `PipelineRunner.emit` puts on the bus. */
const started = { kind: 'run', data: { pipeline: 'festival-classify', outcome: undefined } };
const calling = { kind: 'phase', data: { pipeline: 'festival-classify' } };
const finished = { kind: 'run', data: { pipeline: 'festival-classify', outcome: 'completed' } };

describe('a run on the timeline', () => {
  it('shows all three of its events, not just the brackets', () => {
    expect([started, calling, finished].filter(isOpsEvent)).toHaveLength(3);
  });

  it('keeps the one that says work is happening', () => {
    // This is the regression: `kind !== 'run'` dropped it.
    expect(isOpsEvent(calling)).toBe(true);
  });
});

describe('the development side stays on its own screen', () => {
  it.each([
    ['implementing', { kind: 'phase', data: { stage: 'implementation' } }],
    ['a phase with no data at all', { kind: 'phase' }],
    ['agent activity', { kind: 'activity', data: { stage: 'planning' } }],
    ['an approval', { kind: 'approval' }],
    ['a notice', { kind: 'notice' }],
  ])('%s does not reach the ops timeline', (_label, e) => {
    expect(isOpsEvent(e)).toBe(false);
  });

  it('is told apart by `data.pipeline`, which only the runner attaches', () => {
    // Same kind, different pillar — the field is the whole distinction.
    expect(isOpsEvent({ kind: 'phase', data: { pipeline: 'x' } })).toBe(true);
    expect(isOpsEvent({ kind: 'phase', data: { issue: 'ISS-1' } })).toBe(false);
  });
});

describe('when the counts are re-read', () => {
  it('only on a run boundary', () => {
    // Mid-run the numbers are unchanged; refreshing there is a round trip for nothing, on a
    // screen that already polls every 15 seconds.
    expect(changesCounts(started)).toBe(true);
    expect(changesCounts(finished)).toBe(true);
    expect(changesCounts(calling)).toBe(false);
  });
});

/**
 * The predicate only helps if the screen actually asks it. The bug was one line at the call
 * site, so that is what this guards.
 */
describe('the screen uses it', () => {
  const SVELTE = readFileSync(new URL('../../renderer/src/Pipelines.svelte', import.meta.url), 'utf8');

  it('asks the predicate instead of testing the kind inline', () => {
    expect(SVELTE).toContain('if (!isOpsEvent(e)) return;');
  });

  it('no longer carries the filter that dropped the middle event', () => {
    expect(SVELTE).not.toMatch(/e\.kind !== 'run'/);
  });

  it('refreshes on the boundary only', () => {
    expect(SVELTE).toContain('if (changesCounts(e)) void refresh();');
  });
});
