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
import type { TunnelConfig } from './core-link/tunnel.js';

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
  /**
   * How to reach that machine. When present the app opens the tunnel itself; when absent
   * the address is used as-is, which is what someone who already has a tunnel — or an
   * overlay network — wants (CRL-114).
   */
  tunnel?: TunnelConfig;
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
    tunnel: stored.tunnel,
    token: readToken() ?? undefined,
  };
}

/** What `writeRemote` accepts. Absent means "leave it as it is", never "clear it". */
export type RemotePatch = Partial<Pick<RemoteSettings, 'mode' | 'url' | 'label' | 'tunnel'>>;

/**
 * Change some of the saved settings, keeping the rest.
 *
 * This used to take the whole record and overwrite the file, which made switching mode a
 * destructive act: the renderer called `setMode('local')` with nothing else, so `url`,
 * `label` and `tunnel` were written as absent and the remote setup was gone from disk.
 * Coming back then meant re-entering the server, the ports and the key path — a loss that
 * was one stray click away, while recovering took several deliberate ones (CRL-119).
 *
 * So `undefined` now means "unchanged". Erasing is `clearRemote()`, which has to be asked
 * for by name.
 */
export function writeRemote(patch: RemotePatch): void {
  // Merged on VALUE, not on key presence: the IPC handler builds `{ mode, url, label,
  // tunnel }` every time, so a key is always there and only its value says whether the
  // caller meant anything by it.
  const current = readRemote();
  const next = {
    mode: patch.mode ?? current.mode,
    url: patch.url ?? current.url,
    label: patch.label ?? current.label,
    tunnel: patch.tunnel ?? current.tunnel,
  };
  // Drop the keys that have no value rather than writing `null`s — the file is read by
  // people as well as by this module.
  const body = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
}

/** Forget the remote setup entirely. The one path that is allowed to erase. */
export function clearRemote(): void {
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mode: 'local' }, null, 2), 'utf8');
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
