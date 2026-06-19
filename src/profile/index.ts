/** Resolves the config `profile` block into the runtime surface the core uses:
 * a translator (language) + a stack calibration profile + the optional reference
 * repo. This is the de-masil seam — project/language specifics live here, never in
 * the core. */
import type { Profile } from '../config/schema.js';
import { createTranslator, type Translator } from './i18n.js';
import { resolveStackProfile, type StackProfile } from './stacks.js';

export interface ResolvedProfile {
  language: string;
  t: Translator;
  stack: StackProfile;
  referenceRepo?: string;
}

export function resolveProfile(profile: Profile): ResolvedProfile {
  return {
    language: profile.language,
    t: createTranslator(profile.language),
    stack: resolveStackProfile(profile.stack),
    referenceRepo: profile.reference_repo,
  };
}

export * from './i18n.js';
export * from './stacks.js';
