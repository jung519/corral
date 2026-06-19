/** Stack calibration profiles — the tech-stack seam.
 *
 * Upstream hardcoded stack-specific review examples (NestJS provider injection,
 * Mongoose query without index, Flutter setState after dispose). Those become
 * selectable profiles so the S2 review pipeline calibrates severity per the user's
 * stack instead of a single project's. External profiles can be added later. */

export interface StackProfile {
  id: string;
  /** Example findings that DO warrant a blocker — calibrates reviewer severity. */
  calibrationExamples: string[];
}

const generic: StackProfile = {
  id: 'generic',
  calibrationExamples: [
    'A null/undefined dereference on a hot path',
    'An unhandled promise rejection that crashes the process',
    'Command/SQL injection from unsanitized input',
  ],
};

const nestjs: StackProfile = {
  id: 'nestjs',
  calibrationExamples: [
    'A provider injected with the wrong scope',
    'A database query inside a loop without batching or an index',
    'A missing await on an async repository call',
  ],
};

const flutter: StackProfile = {
  id: 'flutter',
  calibrationExamples: [
    'setState called after the widget is disposed',
    'A BuildContext used across an async gap',
    'A stream subscription never cancelled',
  ],
};

const PROFILES: Record<string, StackProfile> = { generic, nestjs, flutter };

export function resolveStackProfile(id: string): StackProfile {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(`unknown stack profile "${id}"; available: ${availableStacks().join(', ')}`);
  }
  return profile;
}

export function availableStacks(): string[] {
  return Object.keys(PROFILES);
}
