/**
 * Desktop core entrypoint. Forked by the Electron app WITH a Node IPC channel (no TCP
 * port needed), so the process-IPC plane is the primary way in and the WebSocket plane
 * stays off unless the config or `--control-plane` asks for it.
 *
 * Everything about actually being a core lives in core-host.ts — this file is only the
 * "how do clients reach it" half.
 *
 *   <electron-node> dist/ipc-main.js [path/to/corral.yaml]
 */
import { startIpcHost } from './control-plane/ipc.js';
import { startCoreHost } from './core-host.js';
import { logger } from './core/logger.js';

async function main(): Promise<void> {
  // The WS plane runs ALONGSIDE the IPC one when enabled — a desktop-attached core keeps
  // working exactly as before while a remote client can also connect.
  const host = await startCoreHost({ argv: process.argv.slice(2), requirePlane: false });
  startIpcHost(host.deps);
}

main().catch((err: unknown) => {
  logger.error(`corral failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
