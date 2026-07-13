/**
 * Desktop core entrypoint. Forked by the Electron app WITH a Node IPC channel (no TCP
 * port). Bootstraps the orchestrator if config exists, then serves the control plane
 * over IPC (see ipc-host.ts). Credentials come from the injected env (the desktop
 * decrypts keychain secrets into CORRAL_* vars); a file store is the fallback.
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
import { DirectionStore } from './core/direction.js';
import { logger } from './core/logger.js';
import { startIpcHost } from './ipc-host.js';
import type { Orchestrator } from './orchestrator.js';

const configPath = resolve(process.argv[2] ?? 'corral.yaml');
const stateDir = process.env.CORRAL_STATE_DIR ?? '.corral-state';

const fileStore = new FileCredentialStore(resolve(stateDir, 'credentials.json'));
const credentials = new LayeredCredentialStore([new EnvCredentialStore(), fileStore], fileStore);
const channel = new WebChannel();
// Global Direction lives next to corral.yaml in userData (cwd on desktop). Read-only
// here for now — the desktop's direction:write bridge owns writes (Phase 0).
const directionStore = new DirectionStore();

let orchestrator: Orchestrator | undefined;

async function main(): Promise<void> {
  if (existsSync(configPath)) {
    try {
      const config = await loadConfig(configPath);
      const app = await bootstrap(config, { credentials, channel, directionStore });
      orchestrator = app.orchestrator;
      await channel.start();
      await orchestrator.start();
      logger.info('corral configured — orchestrator running (ipc)');
    } catch (err) {
      // Config present but failed to start — surface, but keep the IPC host alive so
      // the renderer can still read status and the user can fix/redo setup.
      logger.error(`config present but failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Setup mode: no config yet. The IPC host serves status; the desktop writes config
    // + respawns this process once setup completes.
    logger.info('corral starting in setup mode (ipc)');
  }

  startIpcHost({ channel, orchestrator: () => orchestrator, directionStore });
}

main().catch((err: unknown) => {
  logger.error(`corral failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
