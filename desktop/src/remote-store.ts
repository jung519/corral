/**
 * Where the desktop keeps its core-connection settings.
 *
 * Split by sensitivity:
 *   - mode / url / label → `userData/remote.json` (plain, not a secret)
 *   - **token**          → OS keychain, like every other credential in the app
 *
 * A pairing code is deliberately *not* stored: it is one-time and short-lived, so it is
 * passed in for a single connection attempt and forgotten.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deleteSecret, getSecret, setSecret } from './keychain.js';

/** Keychain coordinates for the control-plane token. */
const TOKEN_SERVICE = 'corral-remote';
const TOKEN_ACCOUNT = 'token';

export type CoreMode = 'local' | 'remote';

export interface RemoteSettings {
  mode: CoreMode;
  /** e.g. ws://127.0.0.1:4410 — through a tunnel this stays a loopback address. */
  url?: string;
  /** Shown in the core's paired-client list. */
  label?: string;
  /** From the keychain; never written to the file. */
  token?: string;
  /** Set for one connection attempt when pairing; not persisted. */
  pairingCode?: string;
}

function file(): string {
  return join(app.getPath('userData'), 'remote.json');
}

/** Read the saved settings, with the token pulled from the keychain. */
export function readRemote(): RemoteSettings {
  let stored: Partial<RemoteSettings> = {};
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), 'utf8')) as Partial<RemoteSettings>;
  } catch {
    // A corrupt file must not brick startup — fall back to local.
  }
  const mode: CoreMode = stored.mode === 'remote' ? 'remote' : 'local';
  return {
    mode,
    url: stored.url,
    label: stored.label,
    token: readToken() ?? undefined,
  };
}

/** Persist mode/url/label. The token is handled separately (keychain). */
export function writeRemote(settings: { mode: CoreMode; url?: string; label?: string }): void {
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8');
}

export function readToken(): string | null {
  try {
    return getSecret(TOKEN_SERVICE, TOKEN_ACCOUNT);
  } catch {
    // Keychain unavailable (e.g. a headless Linux session) — treat as "not paired".
    return null;
  }
}

export function saveRemoteToken(token: string): void {
  setSecret(TOKEN_SERVICE, TOKEN_ACCOUNT, token);
}

/** Forget this client's pairing — the next connection needs a new code. */
export function clearRemoteToken(): void {
  try {
    deleteSecret(TOKEN_SERVICE, TOKEN_ACCOUNT);
  } catch {
    // Nothing stored, or no keychain; either way there is no token left.
  }
}
