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
    const p = reviewRoundPrompt(issue, 1, 'abc123', profileKo);
    expect(p).toContain('Write the findings in ko');
    expect(p).toContain('특이사항 없음');
    expect(p).toContain('해결됨');
    expect(p).toContain('git diff abc123..HEAD');
    expect(p).toContain('provider injected with the wrong scope'); // nestjs calibration
    expect(p).not.toMatch(/Mongoose|masil_project|design_system/); // no hardcoded masil
  });

  it('reviewRoundPrompt includes the reference repo path when given', () => {
    expect(reviewRoundPrompt(issue, 1, 'b', profileKo, '.corral/reference')).toContain('.corral/reference');
  });

  it('uses generic calibration for the generic stack', () => {
    const generic = resolveProfile(ProfileSchema.parse({}));
    const p = reviewRoundPrompt(issue, 1, 'b', generic);
    expect(p).toContain('Write the findings in en');
    expect(p).toContain('Command/SQL injection');
  });

  it('planCritiquePrompt honors focus and language', () => {
    const pc = planCritiquePrompt(issue, 1, profileKo, undefined, 'perf');
    expect(pc).toContain('focus this review on: "perf"');
    expect(pc).toContain('특이사항 없음');
  });
});
