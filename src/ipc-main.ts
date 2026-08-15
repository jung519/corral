/**
 * Desktop core entrypoint. Forked by the Electron app WITH a Node IPC channel (no TCP
 * port). Bootstraps the orchestrator if config exists, then serves the control plane
 * over IPC and — when configured — WebSocket too (see control-plane/). Credentials come
 * from the injected env (the desktop decrypts keychain secrets into CORRAL_* vars); a
 * file store is the fallback.
 *
 *   <electron-node> dist/ipc-main.js [path/to/corral.yaml]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { WebChannel } from './channel/web.js';
import { loadConfig } from './config/loader.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import { FileCredentialStore } from './credentials/file-store.js';
import { LayeredCredentialStore } from './credentials/layered.js';
import { DirectionCheckStore, DirectionStore } from './core/direction.js';
import { logger } from './core/logger.js';
import type { ControlPlaneConfig } from './config/schema.js';
import { ControlPlaneAuth } from './control-plane/auth.js';
import { startIpcHost } from './control-plane/ipc.js';
import { SetupHost } from './control-plane/setup-host.js';
import { startWsHost } from './control-plane/ws.js';
import type { Orchestrator } from './orchestrator.js';

const configPath = resolve(process.argv[2] ?? 'corral.yaml');
const stateDir = process.env.CORRAL_STATE_DIR ?? '.corral-state';
const draftPath = resolve(stateDir, 'wizard-draft.json');

const fileStore = new FileCredentialStore(resolve(stateDir, 'credentials.json'));
const credentials = new LayeredCredentialStore([new EnvCredentialStore(), fileStore], fileStore);
const channel = new WebChannel();
// Global Direction lives next to corral.yaml in userData (cwd on desktop). Read-only
// here for now — the desktop's direction:write bridge owns writes (Phase 0).
const directionStore = new DirectionStore();
// Direction validation state (consent + verified hashes) — shared by the gate + IPC.
const directionCheck = new DirectionCheckStore(resolve(stateDir));
// Remote control-plane credentials (pairing codes + tokens). Unused by the IPC transport,
// whose parent process is already inside the trust boundary.
const auth = new ControlPlaneAuth(resolve(stateDir));

let orchestrator: Orchestrator | undefined;
let channelStarted = false;

/**
 * Build the orchestrator from the config now on disk and run it — the startup path and
 * also what `configSet` calls after the setup wizard writes a config.
 *
 * Order matters: bootstrap first, swap second. A config that fails to build (bad token,
 * unreachable tracker) then leaves the running orchestrator untouched instead of taking
 * the core down. Errors come back to the caller rather than throwing, so the wizard can
 * show why.
 */
async function reload(): Promise<{ ok: boolean; error?: string }> {
  try {
    const config = await loadConfig(configPath);
    const app = await bootstrap(config, { credentials, channel, directionStore, directionCheck });
    orchestrator?.stop();
    orchestrator = app.orchestrator;
    if (!channelStarted) {
      await channel.start();
      channelStarted = true;
    }
    await orchestrator.start();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const setup = new SetupHost({ configPath, draftPath, credentials, reload });

/**
 * `--revoke <label|all>` drops paired clients; `--pair` forces a fresh pairing code even
 * when clients already exist (adding a device). Both are one-shot flags handled before the
 * core starts serving.
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

async function main(): Promise<void> {
  const revoke = flag('--revoke');
  if (revoke !== undefined) {
    const removed = auth.revoke(revoke || 'all');
    logger.info(`revoked ${removed} control-plane token(s)${revoke ? ` for "${revoke}"` : ''}`);
  }

  const deps = { channel, orchestrator: () => orchestrator, directionStore, directionCheck, setup };
  let remote: ControlPlaneConfig | undefined;

  if (existsSync(configPath)) {
    // Whether the remote plane listens is decided once, here. A later `configSet` that
    // turns it on takes effect on the next core start — you can't open the door you are
    // already standing in, and locally the desktop respawns the core anyway.
    try {
      remote = (await loadConfig(configPath)).control_plane;
    } catch {
      /* reload() reports the real reason below */
    }
    const started = await reload();
    // Config present but failed to start — surface, but keep the IPC host alive so the
    // renderer can still read status and the user can fix/redo setup.
    if (started.ok) logger.info('corral configured — orchestrator running (ipc)');
    else logger.error(`config present but failed to start: ${started.error}`);
  } else {
    // Setup mode: no config yet. The IPC host serves status; the desktop writes config
    // + respawns this process once setup completes.
    logger.info('corral starting in setup mode (ipc)');
  }

  startIpcHost(deps);

  // Remote transport runs ALONGSIDE the IPC one — a desktop-attached core keeps working
  // exactly as before while a remote client can also connect. Off unless configured.
  if (remote?.enabled) {
    // Show a pairing code when nobody has paired yet, or when --pair asks for another
    // device. Existing clients keep working with their tokens, so we stay quiet otherwise.
    if (!auth.hasTokens() || flag('--pair') !== undefined) {
      const code = auth.issueCode();
      logger.info(`control plane pairing code: ${code} (valid 5 minutes, single use)`);
    } else {
      logger.info(`control plane: ${auth.listLabels().length} paired client(s) — run with --pair to add one`);
    }

    try {
      await startWsHost(deps, { host: remote.host, port: remote.port, auth });
    } catch (err) {
      // A busy port must not take the core down; the IPC plane is still serving.
      logger.error(`ws control plane failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err: unknown) => {
  logger.error(`corral failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
