/** Resolves the config `profile` block into the runtime surface the core uses:
 * a translator (language) + a stack calibration profile + the optional reference
 * repo. This is the de-masil seam — project/language specifics live here, never in
 * the core. */
import type { Profile } from '../config/schema.js';
import { createTranslator, type Translator } from './i18n.js';
import { resolveStackProfile, type StackProfile } from './stacks.js';

export interface ResolvedProfile {
  /** Raw config code, e.g. "en", "ko". */
  language: string;
  /** Human-readable language name for agent prompts (a bare code like "ko" is a weak
   *  instruction — the model writes more reliably when told "Korean"). */
  languageName: string;
  t: Translator;
  stack: StackProfile;
  referenceRepo?: string;
}

/** Map a language code to a clear name the model honors; pass anything else through.
 *  The renderer resolves the "auto" (follow-UI) output-language setting to a concrete
 *  code before writing config, so the core should never see "auto"; if it does (e.g. a
 *  hand-edited yaml), fall back to English rather than telling the model to write in
 *  a language literally named "auto". */
export function languageName(code: string): string {
  const names: Record<string, string> = { en: 'English', ko: 'Korean (한국어)', auto: 'English' };
  return names[code] ?? code;
}

export function resolveProfile(profile: Profile): ResolvedProfile {
  return {
    language: profile.language,
    languageName: languageName(profile.language),
    t: createTranslator(profile.language),
    stack: resolveStackProfile(profile.stack),
    referenceRepo: profile.reference_repo,
  };
}

export * from './i18n.js';
export * from './stacks.js';
