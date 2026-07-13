import { describe, expect, it } from 'vitest';
import { ProfileSchema } from '../config/schema.js';
import { createTranslator } from './i18n.js';
import { languageName, resolveProfile } from './index.js';
import { resolveStackProfile } from './stacks.js';

describe('profile', () => {
  it('resolves language + stack from a parsed profile', () => {
    const resolved = resolveProfile(ProfileSchema.parse({ language: 'ko', stack: 'nestjs' }));
    expect(resolved.language).toBe('ko');
    expect(resolved.stack.id).toBe('nestjs');
    expect(resolved.t('review.noIssues')).toBe('특이사항 없음');
  });

  it('defaults to en/generic', () => {
    const resolved = resolveProfile(ProfileSchema.parse({}));
    expect(resolved.language).toBe('en');
    expect(resolved.stack.id).toBe('generic');
    expect(resolved.t('review.noIssues')).toBe('No issues found');
  });

  it('falls back to English for an unknown language', () => {
    expect(createTranslator('fr')('signal.approved')).toBe('APPROVED');
  });

  it('never emits a literal "auto" as an output-language name', () => {
    // The renderer resolves the "follow UI" setting before writing config, but if "auto"
    // ever reaches the core it must degrade to English, not "write in auto".
    expect(languageName('auto')).toBe('English');
    expect(languageName('ko')).toBe('Korean (한국어)');
  });

  it('throws on an unknown stack profile', () => {
    expect(() => resolveStackProfile('cobol')).toThrow(/unknown stack profile "cobol".*generic/s);
  });
});
