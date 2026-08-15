import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { ControlPlaneSchema } from '../config/schema.js';
import { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { bus } from '../core/events.js';
import { ControlPlaneAuth } from './auth.js';
import { dispatch, type ControlPlaneDeps } from './dispatch.js';
import { startWsHost, type WsHost } from './ws.js';

/** Deps with no orchestrator — "setup mode", enough to exercise the transport. */
function deps(): ControlPlaneDeps {
  return {
    channel: new WebChannel(),
    orchestrator: () => undefined,
    directionStore: new DirectionStore('/tmp/corral-test-direction.md'),
    directionCheck: new DirectionCheckStore('/tmp/corral-test-state'),
  };
}

/** Connect and collect messages; resolves once `predicate` is satisfied. */
function collect(port: number, predicate: (msgs: any[]) => boolean, send?: unknown): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs: any[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out; got ${JSON.stringify(msgs)}`));
    }, 4000);
    socket.on('message', (raw) => {
      msgs.push(JSON.parse(String(raw)));
      if (predicate(msgs)) {
        clearTimeout(timer);
        socket.close();
        resolve(msgs);
      }
    });
    socket.on('open', () => {
      if (send) socket.send(JSON.stringify(send));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('ws control plane', () => {
  let host: WsHost | undefined;
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  it('greets each client with ready', async () => {
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0 });
    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'ready'));
    expect(msgs[0]).toEqual({ kind: 'ready' });
  });

  it('answers a request with the same result dispatch() would give', async () => {
    const d = deps();
    host = await startWsHost(d, { host: '127.0.0.1', port: 0 });
    const direct = await dispatch('status', {}, d); // what the IPC transport would return

    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'res'), {
      kind: 'req',
      id: 7,
      method: 'status',
    });

    const res = msgs.find((m) => m.kind === 'res');
    expect(res.id).toBe(7);
    expect(res.result).toEqual(direct); // transport-independent
  });

  it('reports an unknown method as an error instead of crashing', async () => {
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0 });
    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'res'), {
      kind: 'req',
      id: 1,
      method: 'nope',
    });
    const res = msgs.find((m) => m.kind === 'res');
    expect(res.error).toMatch(/unknown method/);
    expect(res.result).toBeUndefined();
  });

  it('streams bus events to connected clients', async () => {
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0 });
    const wait = collect(host.port, (m) => m.some((x) => x.kind === 'event'));
    // Give the socket a moment to attach before emitting.
    setTimeout(() => bus.emitEvent({ identifier: 'ISS-1', kind: 'activity', phase: 'initial', label: '💬 hi' }), 150);
    const msgs = await wait;
    const event = msgs.find((m) => m.kind === 'event');
    expect(event.event).toMatchObject({ identifier: 'ISS-1', label: '💬 hi' });
  });

  it('ignores unparseable frames without dropping the connection', async () => {
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0 });
    const port = host.port;
    const got = await new Promise<any[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const msgs: any[] = [];
      const timer = setTimeout(() => (socket.close(), reject(new Error('timed out'))), 4000);
      socket.on('open', () => {
        socket.send('not json');
        socket.send(JSON.stringify({ kind: 'req', id: 2, method: 'status' }));
      });
      socket.on('message', (raw) => {
        msgs.push(JSON.parse(String(raw)));
        if (msgs.some((m) => m.kind === 'res')) {
          clearTimeout(timer);
          socket.close();
          resolve(msgs);
        }
      });
      socket.on('error', (e) => (clearTimeout(timer), reject(e)));
    });
    expect(got.find((m) => m.kind === 'res').id).toBe(2);
  });

  it('drops the client from fan-out when it disconnects', async () => {
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0 });
    await collect(host.port, (m) => m.some((x) => x.kind === 'ready'));
    // collect() closes the socket once satisfied; the server should notice.
    await new Promise((r) => setTimeout(r, 200));
    expect(host.clients).toBe(0);
  });
});

describe('ws control plane — authentication', () => {
  let host: WsHost | undefined;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corral-ws-auth-'));
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a request from an unauthenticated client', async () => {
    const auth = new ControlPlaneAuth(dir);
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth });

    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'denied'), {
      kind: 'req',
      id: 1,
      method: 'status',
    });
    expect(msgs.find((m) => m.kind === 'denied').reason).toMatch(/not authenticated/);
    expect(msgs.some((m) => m.kind === 'ready' || m.kind === 'res')).toBe(false);
  });

  it('pairs with a valid code, then serves requests', async () => {
    const auth = new ControlPlaneAuth(dir);
    const code = auth.issueCode();
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth });

    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'ready'), {
      kind: 'pair',
      code,
      label: 'macbook',
    });
    const paired = msgs.find((m) => m.kind === 'paired');
    expect(paired.token).toBeTruthy();
    expect(auth.verifyToken(paired.token)).toBe(true);
  });

  it('denies a wrong pairing code', async () => {
    const auth = new ControlPlaneAuth(dir);
    auth.issueCode();
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth });

    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'denied'), {
      kind: 'pair',
      code: '000000',
      label: 'x',
    });
    expect(msgs.find((m) => m.kind === 'denied').reason).toMatch(/pairing code/);
  });

  it('accepts a stored token on a later connection (survives restart)', async () => {
    const auth = new ControlPlaneAuth(dir);
    const token = auth.redeemCode(auth.issueCode(), 'macbook')!;

    // A new auth instance = the core restarted; the token file is the only carry-over.
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth: new ControlPlaneAuth(dir) });
    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'ready'), { kind: 'auth', token });
    expect(msgs.some((m) => m.kind === 'ready')).toBe(true);
  });

  it('denies a revoked token', async () => {
    const auth = new ControlPlaneAuth(dir);
    const token = auth.redeemCode(auth.issueCode(), 'macbook')!;
    auth.revoke('macbook');

    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth });
    const msgs = await collect(host.port, (m) => m.some((x) => x.kind === 'denied'), { kind: 'auth', token });
    expect(msgs.find((m) => m.kind === 'denied').reason).toMatch(/invalid token/);
  });

  it('does not fan out events to unauthenticated sockets', async () => {
    const auth = new ControlPlaneAuth(dir);
    host = await startWsHost(deps(), { host: '127.0.0.1', port: 0, auth });
    const port = host.port;

    const received = await new Promise<any[]>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const msgs: any[] = [];
      socket.on('open', () => {
        // Connected but never authenticates.
        setTimeout(() => bus.emitEvent({ identifier: 'ISS-2', kind: 'activity', phase: 'initial', label: '💬 secret' }), 100);
        setTimeout(() => {
          socket.close();
          resolve(msgs);
        }, 400);
      });
      socket.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    });
    expect(received.some((m) => m.kind === 'event')).toBe(false);
    expect(host.clients).toBe(0);
  });
});

describe('control plane config', () => {
  it('is OFF by default so a local install opens no port', () => {
    const cp = ControlPlaneSchema.parse(undefined);
    expect(cp.enabled).toBe(false);
    expect(cp.host).toBe('127.0.0.1'); // loopback even once enabled
  });

  it('keeps the loopback default when only enabled is set', () => {
    expect(ControlPlaneSchema.parse({ enabled: true }).host).toBe('127.0.0.1');
  });
});
