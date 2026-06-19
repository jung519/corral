/** Headless entrypoint. The control plane ALWAYS starts (no config or credentials
 * required); if no config exists yet it runs in setup mode and serves the wizard,
 * and POST /api/setup writes the config + secrets and brings the orchestrator up.
 *
 *   pnpm start [path/to/corral.yaml]   # default: ./corral.yaml
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { WebChannel } from './channel/web.js';
import { loadConfig } from './config/loader.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import { FileCredentialStore } from './credentials/file-store.js';
import { LayeredCredentialStore } from './credentials/layered.js';
import { logger } from './core/logger.js';
import type { Orchestrator } from './orchestrator.js';
import { DashboardServer, type SetupInput } from './server/dashboard.js';

const configPath = resolve(process.argv[2] ?? 'corral.yaml');
const stateDir = process.env.CORRAL_STATE_DIR ?? '.corral-state';

// Read env first (CI/ops override), then the on-disk file; write to the file store
// so the setup wizard can persist with no keychain / external program.
const fileStore = new FileCredentialStore(resolve(stateDir, 'credentials.json'));
const credentials = new LayeredCredentialStore([new EnvCredentialStore(), fileStore], fileStore);
const channel = new WebChannel();

let orchestrator: Orchestrator | undefined;

async function configure(): Promise<void> {
  const config = await loadConfig(configPath);
  const app = await bootstrap(config, { credentials, channel });
  orchestrator = app.orchestrator;
  await channel.start();
  await orchestrator.start();
  logger.info('corral configured — orchestrator running');
}

async function setup(input: SetupInput): Promise<{ ok: boolean; message?: string }> {
  try {
    for (const s of input.secrets) await credentials.set({ service: s.service, account: s.account }, s.value);
    writeFileSync(configPath, input.config, 'utf8');
    await configure();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  // Precedence: CORRAL_PORT env > config channel.port > default 4400.
  let port = Number(process.env.CORRAL_PORT) || 4400;
  if (existsSync(configPath)) {
    try {
      const cfg = await loadConfig(configPath);
      if (!process.env.CORRAL_PORT) port = cfg.channel.port;
      await configure();
    } catch (err) {
      logger.error(`config present but failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const server = new DashboardServer(port, { channel, orchestrator: () => orchestrator, setup });
  await server.start();
  logger.info(
    orchestrator
      ? `corral ready — http://localhost:${server.boundPort}`
      : `corral ready (setup mode) — open http://localhost:${server.boundPort} to configure`,
  );
}

main().catch((err: unknown) => {
  logger.error(`corral failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
