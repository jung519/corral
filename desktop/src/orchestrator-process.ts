/**
 * Manages the orchestrator (control-plane) child process. The desktop forks the core
 * with a Node IPC channel — NO TCP port. This module is the relay hub:
 *   renderer ──(Electron bridge)──▶ main ──(this: fork IPC)──▶ core (orchestrator)
 * Requests are correlated by id; the core's bus events are forwarded to every window.
 */
import { app, BrowserWindow } from 'electron';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath } from './config-store.js';
import { secretsAsEnv } from './keychain.js';

let child: ChildProcess | undefined;
let ready = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Callers waiting for the core's 'ready' (e.g. the first state fetch after launch). */
let readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

function resolveReady(): void {
  ready = true;
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) w.resolve();
}

function rejectReady(reason: string): void {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) w.reject(new Error(reason));
}

/** Resolve once the core has signalled 'ready' (or reject after a timeout). */
function whenReady(timeoutMs = 8000): Promise<void> {
  if (ready) return Promise.resolve();
  if (!child) return Promise.reject(new Error('orchestrator not running'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((w) => w !== waiter);
      reject(new Error('orchestrator did not become ready in time'));
    }, timeoutMs);
    const waiter = { resolve: () => (clearTimeout(timer), resolve()), reject: (e: Error) => (clearTimeout(timer), reject(e)) };
    readyWaiters.push(waiter);
  });
}

/** Resolve the core entry (corral/dist/ipc-main.js). Override with CORRAL_CORE_ENTRY. */
function coreEntry(): string {
  const fromEnv = process.env.CORRAL_CORE_ENTRY;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (app.isPackaged) return join(process.resourcesPath, 'core', 'dist', 'ipc-main.js');
  return join(app.getAppPath(), '..', 'dist', 'ipc-main.js');
}

function workflowPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'core', 'WORKFLOW.md');
  return join(app.getAppPath(), '..', 'WORKFLOW.md');
}

function forwardEvent(event: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('core-event', event);
}

function onMessage(raw: unknown): void {
  const msg = raw as { kind?: string; id?: number; result?: unknown; error?: string; event?: unknown };
  if (msg.kind === 'ready') {
    resolveReady();
  } else if (msg.kind === 'res' && typeof msg.id === 'number') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } else if (msg.kind === 'event') {
    forwardEvent(msg.event);
  }
}

/** Reject every in-flight request (on a crash/restart) so callers don't hang. */
function flushPending(reason: string): void {
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
}

/** Spawn the core if it isn't running. */
export function startOrchestrator(): void {
  if (child) return;
  ready = false;
  child = spawn(process.execPath, [coreEntry(), configPath()], {
    cwd: app.getPath('userData'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CORRAL_WORKFLOW_PATH: workflowPath(),
      ...secretsAsEnv(),
    },
    // stdout/stderr inherited for logs; 4th fd = IPC channel (no port).
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', onMessage);
  child.on('exit', (code) => {
    child = undefined;
    ready = false;
    flushPending('orchestrator process exited');
    rejectReady('orchestrator process exited');
    if (code && code !== 0) console.error(`orchestrator exited with code ${code}`);
  });
}

/** Kill + respawn — used after setup so the core picks up new config + secrets (env). */
export function restartOrchestrator(): void {
  stopOrchestrator();
  startOrchestrator();
}

export function stopOrchestrator(): void {
  child?.removeAllListeners('message');
  child?.kill('SIGTERM');
  child = undefined;
  ready = false;
  flushPending('orchestrator stopped');
  rejectReady('orchestrator stopped');
}

export function orchestratorRunning(): boolean {
  return child !== undefined;
}

/** Send a request to the core and await its reply (correlated by id). Waits briefly
 *  for the core to become ready (e.g. right after launch or a setup respawn). */
export async function callCore(method: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!child) throw new Error('orchestrator not running');
  if (!ready) await whenReady();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      child!.send({ kind: 'req', id, method, args });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
