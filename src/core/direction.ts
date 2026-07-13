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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
