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

describe('review prompts (de-masil)', () => {
  const profileKo = resolveProfile(ProfileSchema.parse({ language: 'ko', stack: 'nestjs' }));

  it('reviewRoundPrompt renders language, calibration and phrases from the profile', () => {
    const p = reviewRoundPrompt(issue, 1, [{ dir: 'server', base: 'abc123' }], profileKo);
    expect(p).toContain('Write the findings in Korean');
    expect(p).toContain('특이사항 없음');
    expect(p).toContain('해결됨');
    expect(p).toContain('git -C server diff abc123..HEAD');
    expect(p).toContain('provider injected with the wrong scope'); // nestjs calibration
    expect(p).not.toMatch(/Mongoose|masil_project|design_system/); // no hardcoded masil
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
});
