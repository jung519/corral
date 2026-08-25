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
import { SshTunnel, type TunnelConfig, type TunnelStatus } from './tunnel.js';
import type { CoreMessage, CoreTransport, LinkState } from './types.js';

let transport: CoreTransport | undefined;
let ready = false;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Callers waiting for the core's 'ready' (e.g. the first state fetch after launch). */
let readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
/** Last denial from a remote core (wrong code / revoked token) — surfaced to the UI. */
let lastDenial: string | undefined;
/**
 * The tunnel, when the saved settings ask us to open one.
 *
 * It sits **above** the socket deliberately. `remote.ts` retries with backoff, but against
 * a missing tunnel that retry can only ever say "reconnecting" about a port that is not
 * there. So the socket is started when the tunnel is up and stopped when it is not, and
 * the tunnel's own status travels with the link state (CRL-114).
 */
let tunnel: SshTunnel | undefined;
let tunnelStatus: TunnelStatus = { state: 'off' };

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
  broadcastLink(state);
}

/** One shape for every link update, so the tunnel is never missing from it. */
function broadcastLink(state: LinkState): void {
  broadcast('core-link-state', { state, denial: lastDenial, tunnelStatus });
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
      broadcastLink('disconnected');
    },
  });
}

/** Start the link if it isn't running. */
export function startOrchestrator(): void {
  if (transport) return;
  ready = false;
  const remote = readRemote();
  // Built either way: `orchestratorRunning()` and `callCore` must not see "not running"
  // while we are merely waiting for a tunnel to come up.
  transport = createTransport();

  if (remote.mode === 'remote' && remote.url && remote.tunnel) {
    tunnel = openTunnel(remote.tunnel);
    tunnel.start();
    return;
  }
  transport.start();
}

/** Supervise a tunnel and gate the socket on it. */
function openTunnel(cfg: TunnelConfig): SshTunnel {
  return new SshTunnel(
    {
      onStatus: (status) => {
        tunnelStatus = status;
        // Only run the socket while there is something to talk to. Letting it spin against
        // a dead port is exactly the "reconnecting forever" that hid the real cause.
        if (status.state === 'up') transport?.start();
        else transport?.stop();
        broadcastLink(status.state === 'up' ? (transport?.state ?? 'connecting') : 'disconnected');
      },
    },
    cfg,
  );
}

/** Stop + start — used after setup, or when the connection settings change. */
export function restartOrchestrator(): void {
  stopOrchestrator();
  startOrchestrator();
}

export function stopOrchestrator(): void {
  transport?.stop();
  transport = undefined;
  // The tunnel's lifetime is the app's (CRL-114 decision 3) — never leave an orphan ssh
  // holding the local port, or the next start cannot bind it.
  tunnel?.stop();
  tunnel = undefined;
  tunnelStatus = { state: 'off' };
  ready = false;
}

export function orchestratorRunning(): boolean {
  return transport !== undefined;
}

/** Current link state (for the UI): connection state, any refusal reason, and the tunnel. */
export function linkStatus(): { state: LinkState; denial?: string; tunnelStatus: TunnelStatus } {
  return { state: transport?.state ?? 'disconnected', denial: lastDenial, tunnelStatus };
}

/**
 * Exchange a one-time pairing code for a token, then connect for real.
 *
 * Pairing is deliberately a separate, short-lived connection: the code is single-use and
 * never persisted, so it can't live in the saved settings the way a URL does. Once the
 * token is stored, normal startup authenticates with it and the code is irrelevant.
 */
export async function pairRemote(opts: {
  url: string;
  code: string;
  label?: string;
  tunnel?: TunnelConfig;
}): Promise<{ ok: boolean; error?: string; tunnelStatus?: TunnelStatus }> {
  stopOrchestrator(); // don't leave a local core (or an old link) running underneath

  // The tunnel has to exist before anything can be paired through it. Opening it here —
  // rather than telling the operator to open one — is the point of CRL-114.
  if (opts.tunnel) {
    const opened = await raiseTunnel(opts.tunnel);
    if (!opened.ok) {
      startOrchestrator();
      return { ok: false, error: 'tunnel', tunnelStatus: opened.status };
    }
  }

  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.stop();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'unreachable' }), 10_000);

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

  // The pairing tunnel is holding the local port. `startOrchestrator` opens its own, and
  // two ssh processes cannot bind the same port — the second would die with
  // `cannot listen to port`, which `classifyStderr` (rightly) calls fatal. Hand the port
  // over cleanly instead.
  const pairedStatus = tunnelStatus;
  tunnel?.stop();
  tunnel = undefined;
  tunnelStatus = { state: 'off' };

  if (result.ok) {
    writeRemote({ mode: 'remote', url: opts.url, label: opts.label, tunnel: opts.tunnel });
    startOrchestrator(); // reconnect properly, this time with the stored token
  } else {
    startOrchestrator(); // restore whatever mode was configured before
  }
  return { ...result, tunnelStatus: result.ok ? tunnelStatus : pairedStatus };
}

/**
 * Bring a tunnel up (or say why not) before pairing through it.
 *
 * Bounded on purpose: a pairing code is valid for five minutes and the operator is sitting
 * in front of the screen, so waiting forever on a host that will never answer is worse
 * than coming back with a cause they can act on.
 */
function raiseTunnel(cfg: TunnelConfig, timeoutMs = 20_000): Promise<{ ok: boolean; status: TunnelStatus }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, status: tunnelStatus });
    };
    const timer = setTimeout(() => {
      tunnel?.stop();
      tunnel = undefined;
      tunnelStatus = { state: 'failed', code: 'timeout' };
      finish(false);
    }, timeoutMs);

    const probe = new SshTunnel(
      {
        onStatus: (status) => {
          tunnelStatus = status;
          broadcastLink('connecting');
          if (status.state === 'up') finish(true);
          // A fatal cause (no ssh, rejected key) will not improve by waiting it out.
          else if (status.state === 'failed' && status.fatal) finish(false);
        },
      },
      cfg,
    );
    tunnel = probe;
    probe.start();
  });
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
