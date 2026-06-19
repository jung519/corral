/**
 * Manages the orchestrator (control-plane) child process. The desktop app does NOT
 * run the orchestrator in-process — it spawns the headless core (the same
 * `dist/main.js` that runs standalone) with credentials injected as env from the
 * keychain. This keeps the data plane (HTTP+SSE) identical to headless use; the
 * BrowserWindow just points at it.
 */
import { app } from 'electron';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { secretsAsEnv } from './keychain.js';
import { configPath } from './config-store.js';

let child: ChildProcess | undefined;

/** Resolve the core entry (corral/dist/main.js). Override with CORRAL_CORE_ENTRY. */
function coreEntry(): string {
  const fromEnv = process.env.CORRAL_CORE_ENTRY;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // dev layout: desktop/ is a sibling of the built core at ../dist/main.js
  return join(app.getAppPath(), '..', 'dist', 'main.js');
}

export function startOrchestrator(): void {
  if (child) return;
  const entry = coreEntry();
  child = spawn(process.execPath, [entry, configPath()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run electron's bundled node, not a GUI process
      ...secretsAsEnv(),
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    child = undefined;
    if (code && code !== 0) console.error(`orchestrator exited with code ${code}`);
  });
}

export function stopOrchestrator(): void {
  child?.kill('SIGTERM');
  child = undefined;
}

export function orchestratorRunning(): boolean {
  return child !== undefined;
}
