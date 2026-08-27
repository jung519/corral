/**
 * The progress bar's stage mapping.
 *
 * The property that matters is that the bar never walks backwards: a run only ever moves
 * forward, so a bar that steps back is read as the run having gone back. That is what
 * happened — the three spec vetting passes all run under one `plan_reviewing` phase, which
 * mapped to stage 0, so approving the requirements (stage 1) and starting on the design
 * showed `계획` again before landing on `설계` (CRL-128).
 */
import { describe, expect, it } from 'vitest';
import { phaseLabelKey, stageIndex, stageKeys } from './phase';

/** The phases a split-mode run passes through, in order. */
const SPLIT_RUN: Array<[phase: string, specStage?: string]> = [
  ['initial', undefined],
  ['plan_reviewing', 'requirements'],
  ['requirements_sent', 'requirements'],
  ['plan_reviewing', 'design'],
  ['design_sent', 'design'],
  ['plan_reviewing', 'tasks'],
  ['tasks_sent', 'tasks'],
  ['implementing', undefined],
  ['reviewing', undefined],
  ['review_sent', undefined],
  ['pr_open', undefined],
  ['done', undefined],
];

describe('progress bar stages', () => {
  it('never steps backwards across a split-mode run', () => {
    let previous = -1;
    for (const [phase, specStage] of SPLIT_RUN) {
      const at = stageIndex(phase, 'split', specStage);
      expect(at, `${phase}${specStage ? ` (${specStage})` : ''} went back to ${at} from ${previous}`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = at;
    }
  });

  it('sits on the gate it is vetting, not back at planning', () => {
    expect(stageIndex('plan_reviewing', 'split', 'requirements')).toBe(1);
    expect(stageIndex('plan_reviewing', 'split', 'design')).toBe(2);
    expect(stageIndex('plan_reviewing', 'split', 'tasks')).toBe(3);
    // And the badge names that gate rather than "plan".
    expect(phaseLabelKey('plan_reviewing', 'split', 'design')).toBe('kind.design');
  });

  it('holds the stage while a gate opens', () => {
    // Vetting the design and awaiting its approval are the same stage — the bar must not
    // twitch when the card appears.
    expect(stageIndex('plan_reviewing', 'split', 'design')).toBe(stageIndex('design_sent', 'split', 'design'));
  });

  it('leaves single mode exactly as it was', () => {
    expect(stageIndex('initial', undefined)).toBe(0);
    expect(stageIndex('plan_reviewing', undefined)).toBe(0);
    expect(stageIndex('plan_sent', undefined)).toBe(1);
    expect(stageIndex('implementing', undefined)).toBe(2);
    expect(stageIndex('done', undefined)).toBe(5);
    expect(stageKeys(undefined)).toHaveLength(6);
    // A spec stage cannot appear without split mode, but if it did it must change nothing.
    expect(stageIndex('plan_reviewing', undefined, 'design')).toBe(0);
  });

  it('falls back to planning when the stage is missing', () => {
    // A state file written before spec mode, or a stage value this build does not know.
    expect(stageIndex('plan_reviewing', 'split', undefined)).toBe(0);
    expect(stageIndex('plan_reviewing', 'split', 'nonsense')).toBe(0);
  });

  it('puts the post-gate stages after the three gates', () => {
    expect(stageKeys('split')).toHaveLength(8);
    expect(stageIndex('implementing', 'split')).toBe(4);
    expect(stageIndex('reviewing', 'split')).toBe(5);
    expect(stageIndex('pr_open', 'split')).toBe(6);
    expect(stageIndex('done', 'split')).toBe(7);
  });
});
