/**
 * Setup-wizard draft IO — persists the in-progress (NON-secret) wizard fields to
 * userData so a restart mid-setup keeps your inputs. Origin-independent (unlike
 * localStorage, which differs between the Vite dev server and file://). Tokens are
 * never written here — they live encrypted in the keychain (see keychain.ts).
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function draftPath(): string {
  return join(app.getPath('userData'), 'wizard-draft.json');
}

export function readDraft(): string | null {
  try {
    return existsSync(draftPath()) ? readFileSync(draftPath(), 'utf8') : null;
  } catch {
    return null;
  }
}

export function writeDraft(json: string): void {
  const path = draftPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, 'utf8');
}

export function clearDraft(): void {
  try {
    rmSync(draftPath(), { force: true });
  } catch {
    /* already gone */
  }
}
