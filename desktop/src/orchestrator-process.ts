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
  // packaged: extraResources copies the core to resources/core (see electron-builder.yml)
  if (app.isPackaged) return join(process.resourcesPath, 'core', 'dist', 'main.js');
  // dev layout: desktop/ is a sibling of the built core at ../dist/main.js
  return join(app.getAppPath(), '..', 'dist', 'main.js');
}

/** Absolute path to the workflow template (the child's cwd is userData, not the
 * repo, so the core can't find it relative to cwd). */
function workflowPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'core', 'WORKFLOW.md');
  return join(app.getAppPath(), '..', 'WORKFLOW.md');
}

export function startOrchestrator(): void {
  if (child) return;
  const entry = coreEntry();
  child = spawn(process.execPath, [entry, configPath()], {
    // Run from a writable dir (logs/ + .corral-state/ are created relative to cwd;
    // resources/ is read-only in a packaged app).
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run electron's bundled node, not a GUI process
      CORRAL_WORKFLOW_PATH: workflowPath(),
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
