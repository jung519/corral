/**
 * Global Direction file IO for the desktop app — the free-text "방향성 / org intent"
 * lives in userData/direction.md, next to corral.yaml. The core reads the SAME file
 * (via src/core/direction.ts, cwd = userData on spawn) to inject it into prompts.
 * See docs/direction-injection-plan.md.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function directionPath(): string {
  return join(app.getPath('userData'), 'direction.md');
}

export function readDirection(): string {
  try {
    return existsSync(directionPath()) ? readFileSync(directionPath(), 'utf8') : '';
  } catch {
    return '';
  }
}

export function writeDirection(text: string): void {
  const path = directionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
