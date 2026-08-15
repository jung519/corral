/**
 * Headless entrypoint — a core with no GUI and no parent process. This is how Corral
 * runs on a VM or a server; the desktop app then attaches to it from a laptop.
 *
 *   node dist/main.js [path/to/corral.yaml] [--control-plane [host:]port] [--pair] [--revoke <label|all>]
 *
 * The WebSocket control plane is always on here — it is the only way in. It binds
 * 127.0.0.1 by default, so reaching it from another machine means an SSH tunnel or a
 * VPN rather than an open port; pass `--control-plane 0.0.0.0:4410` only behind one.
 *
 * A config is NOT required to start. Without one the core comes up in setup mode and
 * waits: the wizard writes the config over this same plane, and the core reloads itself
 * in place. Requiring a config first would be circular — you'd need the machine
 * configured before you could configure it.
 */
import { startCoreHost } from './core-host.js';
import { logger } from './core/logger.js';

async function main(): Promise<void> {
  const host = await startCoreHost({ argv: process.argv.slice(2), requirePlane: true });

  // A service manager (systemd, Docker) stops us with SIGTERM; Ctrl-C sends SIGINT. Both
  // mean the same thing: stop serving and let the process end on its own once nothing is
  // holding it open. Issues mid-flight keep their state on disk and are reattached on the
  // next start, so there is nothing to drain — but we must not exit while still listening.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return; // a second Ctrl-C shouldn't interleave two shutdowns
      stopping = true;
      logger.info(`${signal} received — shutting down`);
      void host.shutdown().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        },
      );
    });
  }

  logger.info('corral running headless — attach the desktop app to this control plane');
}

main().catch((err: unknown) => {
  logger.error(`corral failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
