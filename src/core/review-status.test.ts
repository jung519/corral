/**
 * Verification goes from two layers to three here: static gate (deterministic) →
 * acceptance criteria (spec) → LLM review (judgement).
 *
 * The point of the middle layer is that it is NOT judgement. The count arrives as its own
 * field and the verdict is computed, so a model that miscounts — or quietly calls an unmet
 * criterion met — cannot wave a missing requirement through.
 */
import { describe, expect, it } from 'vitest';
import { fixableCount, isReviewClean, parseReviewStatus, unmetCriteria } from './review-status.js';

const json = (o: unknown) => JSON.stringify(o);

describe('parseReviewStatus', () => {
  it('reads the three counts as before', () => {
    expect(parseReviewStatus(json({ blocker: 1, suggestion: 2, nit: 3 }))).toEqual({
      blocker: 1,
      suggestion: 2,
      nit: 3,
    });
  });

  /**
   * A plan with no REQ labels — hand-written, or made before criteria were required — must
   * come out with no `criteria` at all. `{total: 0, met: 0}` would be a claim that the plan
   * defined zero criteria, which is a different statement.
   */
  it('leaves criteria absent when the file has none', () => {
    expect(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0 }))).not.toHaveProperty('criteria');
  });

  it('reads criteria when they are there', () => {
    expect(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0, criteria: { total: 4, met: 3 } }))?.criteria).toEqual({
      total: 4,
      met: 3,
    });
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseReviewStatus(null)).toBeNull();
    expect(parseReviewStatus('not json')).toBeNull();
  });

  // Model-authored JSON. Anything incoherent is dropped rather than guessed at, which lands
  // on the pre-existing behaviour instead of inventing a verdict out of nonsense.
  it.each([
    ['more met than exist', { total: 2, met: 5 }],
    ['non-numeric', { total: 'four', met: 'three' }],
    ['negative', { total: -1, met: -1 }],
    ['not an object', 'four of five'],
  ])('drops criteria that are %s', (_label, criteria) => {
    const parsed = parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0, criteria }));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('criteria');
  });
});

describe('isReviewClean', () => {
  it('is clean with no findings and every criterion met', () => {
    expect(isReviewClean(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0, criteria: { total: 4, met: 4 } })))).toBe(true);
  });

  /**
   * The whole issue in one assertion. This is the shape CRL-99 measured: the reviewer found
   * REQ-3 unimplemented while everything else was fine. Without this the branch would open
   * a PR with an approved requirement simply missing.
   */
  it('is NOT clean when a criterion is unmet, however quiet the rest of the review is', () => {
    const status = parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0, criteria: { total: 4, met: 3 } }));
    expect(unmetCriteria(status)).toBe(1);
    expect(isReviewClean(status)).toBe(false);
  });

  it('is not clean when there are blockers, criteria or not', () => {
    expect(isReviewClean(parseReviewStatus(json({ blocker: 1, suggestion: 0, nit: 0 })))).toBe(false);
  });

  it('keeps the old behaviour for a plan with no criteria', () => {
    expect(isReviewClean(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0 })))).toBe(true);
  });

  it('does not block on a plan that defined zero criteria', () => {
    expect(isReviewClean(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 0, criteria: { total: 0, met: 0 } })))).toBe(true);
  });

  it('treats a missing status file as before', () => {
    expect(isReviewClean(null)).toBe(true);
  });
});

describe('fixableCount', () => {
  it('counts unmet criteria alongside blockers and suggestions', () => {
    expect(fixableCount(parseReviewStatus(json({ blocker: 1, suggestion: 2, nit: 9, criteria: { total: 4, met: 2 } })))).toBe(5);
  });

  it('ignores NITs, as before', () => {
    expect(fixableCount(parseReviewStatus(json({ blocker: 0, suggestion: 0, nit: 7 })))).toBe(0);
  });
});
