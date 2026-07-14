/**
 * Global (machine-wide) Direction store — the free-text "org intent / 방향성" that,
 * from Phase 1 on, is merged with the per-project `.corral/DIRECTION.md` and injected
 * into planning/review prompts. See docs/direction-injection-plan.md.
 *
 * This file only handles the GLOBAL scope. The desktop writes it (userData/direction.md
 * via its own IPC bridge); the core reads it here. The path is injectable (env
 * `CORRAL_DIRECTION_PATH`, else `direction.md` relative to cwd = userData on desktop),
 * mirroring the `CORRAL_STATE_DIR` pattern so tests and non-desktop runs stay decoupled.
 *
 * Reads hit disk every call (no cache) so a desktop edit is picked up without respawning
 * the core. Empty/missing file → empty string (= no Direction, nothing to inject).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_STATE_DIR } from './issue-state.js';

export const DEFAULT_DIRECTION_PATH = process.env.CORRAL_DIRECTION_PATH ?? 'direction.md';

export class DirectionStore {
  private readonly file: string;

  constructor(path: string = DEFAULT_DIRECTION_PATH) {
    this.file = resolve(path);
  }

  /** Absolute path of the global Direction file. */
  get path(): string {
    return this.file;
  }

  /** Current global Direction text, or '' if unset/missing. */
  read(): string {
    if (!existsSync(this.file)) return '';
    try {
      return readFileSync(this.file, 'utf8');
    } catch {
      return '';
    }
  }

  /** Persist the global Direction text (creates the parent dir if needed). */
  write(text: string): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, text, 'utf8');
  }
}

/** Scope key for the verification store. Currently a single machine-wide Direction —
 *  per-project (`.corral/DIRECTION.md`) scope was intentionally dropped (too much manual
 *  git friction, off the "zero-config" product direction). */
export type DirectionScope = 'global';

/** Content hash a Direction scope is "verified" against (trimmed, so whitespace-only
 *  edits don't force re-checks). Editing the text changes the hash → auto-unverified. */
export function directionHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

interface CheckState {
  /** One-time user consent to spend AI on validating Direction text (see §15.6). */
  consent: boolean;
  /** scope key → hash of the text that passed validation. */
  verified: Record<string, string>;
}

/**
 * Persists Direction-validation state (§15): the one-time consent flag and, per scope,
 * the hash of the text an AI check approved. The core is the SOLE owner/writer so there
 * is no read-modify-write race with the desktop. Verified is hash-based, so any edit to
 * the text (UI save or a committed `.corral/DIRECTION.md` change) auto-invalidates it.
 */
export class DirectionCheckStore {
  private readonly file: string;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    this.file = resolve(stateDir, 'direction-check.json');
  }

  private load(): CheckState {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CheckState>;
      return { consent: s.consent === true, verified: s.verified ?? {} };
    } catch {
      return { consent: false, verified: {} };
    }
  }

  private save(state: CheckState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 2), 'utf8');
  }

  getConsent(): boolean {
    return this.load().consent;
  }

  setConsent(value: boolean): void {
    const state = this.load();
    state.consent = value;
    this.save(state);
  }

  /** True when this exact text (by hash) has passed validation for this scope. */
  isVerified(scope: DirectionScope, text: string): boolean {
    return this.load().verified[scope] === directionHash(text);
  }

  markVerified(scope: DirectionScope, text: string): void {
    const state = this.load();
    state.verified[scope] = directionHash(text);
    this.save(state);
  }
}

/** Parse the Direction safety-check verdict the agent writes (§15). Tolerant of the agent
 *  wrapping the JSON in prose/fences — extracts the first `{…}`. null if absent/unparseable
 *  (treated as "couldn't validate", not a rejection). */
export function parseDirectionVerdict(raw: string | null): { approved: boolean; reason: string } | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { approved?: unknown; reason?: unknown };
    if (typeof obj.approved !== 'boolean') return null;
    return { approved: obj.approved, reason: typeof obj.reason === 'string' ? obj.reason : '' };
  } catch {
    return null;
  }
}
