import { describe, expect, it } from 'vitest';
import { ProfileSchema } from '../config/schema.js';
import type { Issue } from '../core/types.js';
import { resolveProfile } from '../profile/index.js';
import { planCritiquePrompt, reviewRoundPrompt } from './prompt.js';

const issue: Issue = {
  identifier: 'ISS-1',
  internalId: 'x',
  title: 't',
  description: '',
  state: 'in_progress',
  labels: [],
  blockedBy: [],
  attachments: [],
};

describe('review prompts', () => {
  const profileKo = resolveProfile(ProfileSchema.parse({ language: 'ko', stack: 'nestjs' }));

  it('reviewRoundPrompt renders language, calibration and phrases from the profile', () => {
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'server', base: 'abc123' }], profileKo);
    expect(p).toContain('Write the findings in Korean');
    expect(p).toContain('특이사항 없음');
    expect(p).toContain('해결됨');
    expect(p).toContain('git -C server diff abc123..HEAD');
    expect(p).toContain('provider injected with the wrong scope'); // nestjs calibration
    // Another stack's calibration must NOT be there. That is the whole claim: the
    // examples come from the profile, so a prompt cannot carry a stack nobody chose.
    expect(p).not.toContain('BuildContext used across an async gap'); // flutter calibration
  });

  it('reviewRoundPrompt lists every changed repo for a multi-repo issue', () => {
    const p = reviewRoundPrompt(
      issue,
      1,
      [
        { dir: 'server', base: 'aaa' },
        { dir: 'app', base: 'bbb' },
      ],
      profileKo,
    );
    expect(p).toContain('git -C server diff aaa..HEAD');
    expect(p).toContain('git -C app diff bbb..HEAD');
    expect(p).toContain('span 2 repos');
  });

  it('reviewRoundPrompt includes the reference repo path when given', () => {
    expect(reviewRoundPrompt(issue, 1, [{ dir: 'app', base: 'b' }], profileKo, '.corral/reference')).toContain(
      '.corral/reference',
    );
  });

  it('reviewRoundPrompt injects the Direction with a severity-calibration guard', () => {
    const dir = '### Global direction (org / operator)\nMVP speed first';
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'app', base: 'b' }], profileKo, undefined, dir);
    expect(p).toContain('MVP speed first'); // the direction text is present
    expect(p).toContain('calibrate SEVERITY'); // framing that it only tunes severity
    expect(p).toMatch(/does NOT change correctness/i); // correctness bugs stay BLOCKER
    // Omitted when no direction is set.
    expect(reviewRoundPrompt(issue, 1, [{ dir: 'app', base: 'b' }], profileKo)).not.toContain('calibrate SEVERITY');
  });

  it('uses generic calibration for the generic stack', () => {
    const generic = resolveProfile(ProfileSchema.parse({}));
    const p = reviewRoundPrompt(issue, 1, [{ dir: '.', base: 'b' }], generic);
    expect(p).toContain('Write the findings in English');
    expect(p).toContain('Command/SQL injection');
  });

  it('planCritiquePrompt honors focus and language', () => {
    const pc = planCritiquePrompt(issue, 1, profileKo, undefined, 'perf');
    expect(pc).toContain('focus this review on: "perf"');
    expect(pc).toContain('특이사항 없음');
  });

  it('planCritiquePrompt injects the Direction as guiding (not a rule)', () => {
    const dir = '### Global direction (org / operator)\nprefer fewer dependencies';
    const pc = planCritiquePrompt(issue, 1, profileKo, undefined, undefined, dir);
    expect(pc).toContain('prefer fewer dependencies');
    expect(pc).toContain('guiding, not a rule');
    expect(planCritiquePrompt(issue, 1, profileKo)).not.toContain('guiding, not a rule');
  });
});

/**
 * CRL-99 — the criteria are written down (CRL-98) and survive to review time (CRL-88).
 * These pin the third leg: somebody actually rules on them.
 */
describe('acceptance-criteria check', () => {
  const profileKo = resolveProfile(ProfileSchema.parse({ language: 'ko', stack: 'nestjs' }));
  const profileEn = resolveProfile(ProfileSchema.parse({ language: 'en', stack: 'nestjs' }));

  it('the review round reads the approved plan and rules on each REQ', () => {
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'server', base: 'abc123' }], profileEn);
    expect(p).toContain('.corral/pending_plan.md');
    expect(p).toMatch(/For EACH `REQ-n`/);
    expect(p).toContain('MET');
    expect(p).toContain('UNMET');
  });

  it('the verdict words come from the profile like every other review phrase', () => {
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'server', base: 'abc123' }], profileKo);
    expect(p).toContain('충족');
    expect(p).toContain('미충족');
  });

  /**
   * The repo is already running. Issues planned before CRL-98 have no REQ labels, and a
   * reviewer that reports their absence would turn every in-flight issue into a finding.
   * Same shape as the "prevReview does not exist → first review" escape below it.
   */
  it('tells the reviewer to skip the check when the plan has no REQ labels', () => {
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'server', base: 'abc123' }], profileEn);
    expect(p).toMatch(/If the plan has NO `REQ-n` labels[\s\S]*SKIP this entirely/);
    expect(p).toMatch(/Do not report their absence as a problem/);
  });

  it('the plan critic looks between requirements, not just at each one', () => {
    const p = planCritiquePrompt(issue, 1, profileEn);
    expect(p).toMatch(/Problems BETWEEN requirements/);
    // The three axes a per-item read misses.
    expect(p).toMatch(/cannot both hold/);          // 논리적 모순
    expect(p).toMatch(/at the same time/);          // 충돌하는 제약
    expect(p).toMatch(/as if it already existed/);  // 암묵적 가정
  });

  it('the plan critic names unquantified words instead of only saying "vague"', () => {
    const p = planCritiquePrompt(issue, 1, profileEn);
    expect(p).toMatch(/large volume|fast response/);
  });
});
