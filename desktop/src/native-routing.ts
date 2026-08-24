/**
 * Where each native capability points — this machine, or the machine the core runs on.
 *
 * In local mode nothing changes: the core is a child process here, so this app's disk
 * and the core's disk are the same disk. In remote mode they are not, and the split
 * follows one question — **whose answer would be a lie?**
 *
 *   → the core   config, secrets, direction, wizard draft, Docker/CLI detection.
 *                The agents run over there. Docker "available" has to mean available
 *                to them, and a token has to be readable by them.
 *   → stays here provider login capture, OS notifications, app version.
 *                Login opens a browser and a VM has none. The captured token is then
 *                stored through `secretSet`, so it still ends up on the core.
 *
 * Reads fall back to a safe answer when the link is down rather than throwing, so a
 * dropped connection doesn't take the window with it. Writes are never swallowed —
 * a save that didn't happen must say so.
 */
import { execFile } from 'node:child_process';
import { callCore } from './core-link/index.js';
import { configExists as localConfigExists, readConfig as localConfigRead, writeConfig as localConfigWrite } from './config-store.js';
import { readDirection as localDirectionRead, writeDirection as localDirectionWrite } from './direction-store.js';
import { clearDraft as localDraftClear, readDraft as localDraftRead, writeDraft as localDraftWrite } from './draft-store.js';
import { deleteSecret as localSecretDelete, hasSecret as localSecretHas, setSecret as localSecretSet } from './keychain.js';
import { readRemote } from './remote-store.js';

/** True when the core lives on another machine. Read per call — the user can switch modes
 *  from Settings without restarting the app. */
export function isRemote(): boolean {
  return readRemote().mode === 'remote';
}

/** A read whose failure must not break the screen asking for it. */
async function readSafely<T>(call: () => Promise<T>, whenDown: T): Promise<T> {
  try {
    return await call();
  } catch {
    return whenDown;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────────

/**
 * Whether the core has a config. On a dropped remote link we answer **yes**: the app
 * pushes an unconfigured user into the setup wizard, and a momentary disconnect must
 * not yank someone out of what they were doing. A genuinely unconfigured core is one
 * reconnect away from saying so.
 */
export async function configExists(): Promise<boolean> {
  if (!isRemote()) return localConfigExists();
  return readSafely(async () => ((await callCore('configGet')) as { exists: boolean }).exists, true);
}

export async function configRead(): Promise<string | null> {
  if (!isRemote()) return localConfigRead();
  return readSafely(async () => ((await callCore('configGet')) as { yaml: string | null }).yaml, null);
}

/**
 * The config, parsed, with the schema's defaults filled in.
 *
 * Always asked of the core, local or remote — the core is the only side with a YAML
 * parser and the schema, and it is running in both modes. `undefined` when it is not up
 * yet or the config does not parse; a screen that gets that has nothing to show and says
 * so, rather than rendering half a config (CRL-76).
 */
export async function configParsed(): Promise<{ config?: unknown; raw?: unknown }> {
  return readSafely(
    async () => {
      const got = (await callCore('configGet')) as { config?: unknown; raw?: unknown };
      return { config: got.config, raw: got.raw };
    },
    { config: undefined, raw: undefined },
  );
}

/**
 * Flip spec mode. Always the core's job, local or remote — it owns the YAML parser and the
 * schema, and a one-key document written from here would erase the rest (CRL-104).
 */
export async function specModeWrite(mode: 'single' | 'split'): Promise<{ ok: boolean; error?: string }> {
  return (await callCore('specModeSet', { mode })) as { ok: boolean; error?: string };
}

/**
 * Persist the config. Remotely this also brings the core up on it (there is no parent
 * process out there to respawn it), so the reload's verdict is what comes back — the
 * wizard shows it instead of claiming success.
 */
export async function configWrite(yaml: string): Promise<{ ok: boolean; error?: string }> {
  if (!isRemote()) {
    // Ask the core to put back the blocks the wizard does not model, then write. The core
    // is the only side that knows what a config contains; writing the wizard's document
    // straight to disk is what erased them (CRL-77). If the core cannot answer, the write
    // still happens — a save that refuses because the merge was unavailable would be a
    // worse failure than the one being avoided.
    const merged = await readSafely(async () => ((await callCore('configMerge', { yaml })) as { yaml: string }).yaml, yaml);
    localConfigWrite(merged);
    return { ok: true };
  }
  return (await callCore('configSet', { yaml })) as { ok: boolean; error?: string };
}

// ── Secrets ───────────────────────────────────────────────────────────────────────
// Only existence ever comes back. No path here reads a secret value off the core.

export async function secretSet(service: string, account: string, value: string): Promise<void> {
  if (!isRemote()) return localSecretSet(service, account, value);
  await callCore('secretSet', { service, account, value });
}

export async function secretHas(service: string, account: string): Promise<boolean> {
  if (!isRemote()) return localSecretHas(service, account);
  return readSafely(async () => ((await callCore('secretHas', { service, account })) as { has: boolean }).has, false);
}

export async function secretDelete(service: string, account: string): Promise<void> {
  if (!isRemote()) return localSecretDelete(service, account);
  await callCore('secretDelete', { service, account });
}

// ── Direction and wizard draft ────────────────────────────────────────────────────

export async function directionRead(): Promise<string> {
  if (!isRemote()) return localDirectionRead();
  return readSafely(async () => ((await callCore('direction')) as { text: string }).text, '');
}

export async function directionWrite(text: string): Promise<void> {
  if (!isRemote()) return localDirectionWrite(text);
  await callCore('directionWrite', { text });
}

export async function draftRead(): Promise<string | null> {
  if (!isRemote()) return localDraftRead();
  return readSafely(async () => ((await callCore('draftGet')) as { json: string | null }).json, null);
}

export async function draftWrite(json: string): Promise<void> {
  if (!isRemote()) return localDraftWrite(json);
  await callCore('draftSet', { json });
}

export async function draftClear(): Promise<void> {
  if (!isRemote()) return localDraftClear();
  await callCore('draftClear');
}

// ── Host probes ───────────────────────────────────────────────────────────────────
// Answered by whichever machine will actually run the containers and CLIs.

export async function detectDocker(): Promise<{ available: boolean; version?: string }> {
  if (!isRemote()) return localDetectDocker();
  return readSafely(
    async () => (await callCore('detectDocker')) as { available: boolean; version?: string },
    { available: false },
  );
}

export async function detectCli(provider: string): Promise<{ installed: boolean; version?: string }> {
  if (!isRemote()) return localDetectCli(provider);
  return readSafely(
    async () => (await callCore('detectCli', { provider })) as { installed: boolean; version?: string },
    { installed: false },
  );
}

const PROBE_TIMEOUT_MS = 5_000;

/** `<bin> --version` on this machine, or null if the binary isn't usable. */
function version(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : (stdout.trim().split('\n')[0] ?? ''));
    });
  });
}

async function localDetectDocker(): Promise<{ available: boolean; version?: string }> {
  const v = await version('docker');
  return v === null ? { available: false } : { available: true, version: v };
}

/** The official CLI binary per provider — a fixed table, never interpolated from the
 *  caller's string (same rule the core's probe follows). */
const CLI_BIN: Record<string, string> = { claude: 'claude', gemini: 'gemini', gpt: 'codex' };

async function localDetectCli(provider: string): Promise<{ installed: boolean; version?: string }> {
  const bin = CLI_BIN[provider];
  if (!bin) return { installed: false };
  const v = await version(bin);
  return v === null ? { installed: false } : { installed: true, version: v };
}
