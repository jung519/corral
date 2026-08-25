/**
 * Local transport: the app forks the core as a child process and talks to it over the
 * Node IPC channel — **no TCP port**. This is the default and what a single-machine
 * install uses.
 *
 * Split out of this app's own `orchestrator-process.ts` with the spawn behaviour unchanged;
 * only the plumbing around it (request correlation, event relay) moved out.
 */
import { app } from 'electron';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath } from '../config-store.js';
import { secretsAsEnv } from '../keychain.js';
import type { CoreMessage, CoreTransport, LinkState, TransportHandlers } from './types.js';

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

export class LocalTransport implements CoreTransport {
  private child: ChildProcess | undefined;
  state: LinkState = 'disconnected';

  constructor(private readonly handlers: TransportHandlers) {}

  private setState(state: LinkState): void {
    this.state = state;
    this.handlers.onState?.(state);
  }

  start(): void {
    if (this.child) return;
    this.setState('connecting');
    this.child = spawn(process.execPath, [coreEntry(), configPath()], {
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
    this.child.on('message', (raw: unknown) => {
      const msg = raw as CoreMessage;
      if (msg?.kind === 'ready') this.setState('connected');
      this.handlers.onMessage(msg);
    });
    this.child.on('exit', (code) => {
      this.child = undefined;
      this.setState('disconnected');
      this.handlers.onDown('orchestrator process exited');
      if (code && code !== 0) console.error(`orchestrator exited with code ${code}`);
    });
  }

  stop(): void {
    this.child?.removeAllListeners('message');
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.setState('disconnected');
    this.handlers.onDown('orchestrator stopped');
  }

  send(message: unknown): void {
    if (!this.child) throw new Error('orchestrator not running');
    this.child.send(message as object);
  }

  isUp(): boolean {
    return this.child !== undefined;
  }
}
