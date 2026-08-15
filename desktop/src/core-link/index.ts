/**
 * The desktop's link to the core: request correlation, ready-waiting, and event relay,
 * written once for both transports.
 *
 *   renderer ──(Electron bridge)──▶ main ──(this)──▶ core
 *
 * Which transport is used comes from the saved connection mode: `local` forks the core
 * here, `remote` connects to one running elsewhere. Everything above this module — the
 * IPC handlers in `main.ts` and the renderer — is unaware of the difference.
 */
import { BrowserWindow } from 'electron';
import { readRemote, saveRemoteToken, writeRemote } from '../remote-store.js';
import { LocalTransport } from './local.js';
import { RemoteTransport } from './remote.js';
import type { CoreMessage, CoreTransport, LinkState } from './types.js';

let transport: CoreTransport | undefined;
let ready = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Callers waiting for the core's 'ready' (e.g. the first state fetch after launch). */
let readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
/** Last denial from a remote core (wrong code / revoked token) — surfaced to the UI. */
let lastDenial: string | undefined;

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
  if (!transport) return Promise.reject(new Error('orchestrator not running'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((w) => w !== waiter);
      reject(new Error('orchestrator did not become ready in time'));
    }, timeoutMs);
    const waiter = {
      resolve: () => (clearTimeout(timer), resolve()),
      reject: (e: Error) => (clearTimeout(timer), reject(e)),
    };
    readyWaiters.push(waiter);
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function onMessage(msg: CoreMessage): void {
  if (msg.kind === 'ready') {
    resolveReady();
  } else if (msg.kind === 'res' && typeof msg.id === 'number') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } else if (msg.kind === 'event') {
    broadcast('core-event', msg.event);
  }
}

/** Reject every in-flight request (on a crash/restart/disconnect) so callers don't hang. */
function onDown(reason: string): void {
  ready = false;
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
  rejectReady(reason);
}

function onState(state: LinkState): void {
  // The UI shows this for remote links; harmless for local.
  broadcast('core-link-state', { state, denial: lastDenial });
}

const handlers = { onMessage, onDown, onState };

/** Build the transport the saved settings ask for. */
function createTransport(): CoreTransport {
  const remote = readRemote();
  if (remote.mode !== 'remote' || !remote.url) return new LocalTransport(handlers);

  lastDenial = undefined;
  return new RemoteTransport(handlers, {
    url: remote.url,
    token: remote.token,
    pairingCode: remote.pairingCode,
    label: remote.label,
    // Pairing spends a one-time code; persist the token so later launches skip it.
    onPaired: (token) => saveRemoteToken(token),
    onDenied: (reason) => {
      lastDenial = reason;
      broadcast('core-link-state', { state: 'disconnected', denial: reason });
    },
  });
}

/** Start the link if it isn't running. */
export function startOrchestrator(): void {
  if (transport) return;
  ready = false;
  transport = createTransport();
  transport.start();
}

/** Stop + start — used after setup, or when the connection settings change. */
export function restartOrchestrator(): void {
  stopOrchestrator();
  startOrchestrator();
}

export function stopOrchestrator(): void {
  transport?.stop();
  transport = undefined;
  ready = false;
}

export function orchestratorRunning(): boolean {
  return transport !== undefined;
}

/** Current link state (for the UI): connection state plus any refusal reason. */
export function linkStatus(): { state: LinkState; denial?: string } {
  return { state: transport?.state ?? 'disconnected', denial: lastDenial };
}

/**
 * Exchange a one-time pairing code for a token, then connect for real.
 *
 * Pairing is deliberately a separate, short-lived connection: the code is single-use and
 * never persisted, so it can't live in the saved settings the way a URL does. Once the
 * token is stored, normal startup authenticates with it and the code is irrelevant.
 */
export async function pairRemote(opts: { url: string; code: string; label?: string }): Promise<{
  ok: boolean;
  error?: string;
}> {
  stopOrchestrator(); // don't leave a local core (or an old link) running underneath

  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.stop();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '연결할 수 없습니다 — 주소와 터널을 확인하세요.' }), 10_000);

    const probe = new RemoteTransport(
      { onMessage: () => {}, onDown: () => {} },
      {
        url: opts.url,
        pairingCode: opts.code,
        label: opts.label ?? 'desktop',
        onPaired: (token) => {
          saveRemoteToken(token);
          finish({ ok: true });
        },
        onDenied: (reason) => finish({ ok: false, error: reason }),
      },
    );
    probe.start();
  });

  if (result.ok) {
    writeRemote({ mode: 'remote', url: opts.url, label: opts.label });
    startOrchestrator(); // reconnect properly, this time with the stored token
  } else {
    startOrchestrator(); // restore whatever mode was configured before
  }
  return result;
}

/** Send a request to the core and await its reply (correlated by id). Waits briefly
 *  for the core to become ready (e.g. right after launch or a setup respawn). */
export async function callCore(method: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!transport) throw new Error('orchestrator not running');
  if (!ready) await whenReady();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      transport!.send({ kind: 'req', id, method, args });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
