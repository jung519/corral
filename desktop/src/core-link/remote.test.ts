import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteTransport } from './remote.js';
import type { CoreMessage, LinkState } from './types.js';

/**
 * A stand-in core: speaks the same handshake as `control-plane/ws.ts` so the transport is
 * exercised against real socket behaviour (including drops), without booting a core.
 */
async function fakeCore(opts: { code?: string; token?: string } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const clients = new Set<WebSocket>();
  // Wait for the OS to assign a port — reading address() earlier yields 0, and connecting
  // to port 0 fails with EADDRNOTAVAIL.
  await new Promise<void>((done) => wss.on('listening', () => done()));
  const { port } = wss.address() as { port: number };

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as CoreMessage & { code?: string; token?: string; method?: string };
      if (msg.kind === 'pair') {
        if (opts.code && msg.code === opts.code) {
          socket.send(JSON.stringify({ kind: 'paired', token: 'issued-token' }));
          socket.send(JSON.stringify({ kind: 'ready' }));
        } else {
          socket.send(JSON.stringify({ kind: 'denied', reason: 'invalid or expired pairing code' }));
          socket.close();
        }
      } else if (msg.kind === 'auth') {
        if (opts.token && msg.token === opts.token) socket.send(JSON.stringify({ kind: 'ready' }));
        else {
          socket.send(JSON.stringify({ kind: 'denied', reason: 'invalid token' }));
          socket.close();
        }
      } else if (msg.kind === 'req') {
        socket.send(JSON.stringify({ kind: 'res', id: msg.id, result: { ok: true } }));
      }
    });
    socket.on('close', () => clients.delete(socket));
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    /** Drop every client without shutting the port — simulates a core restart. */
    dropClients() {
      for (const c of clients) c.terminate();
      clients.clear();
    },
    close: () =>
      new Promise<void>((done) => {
        for (const c of clients) c.terminate();
        wss.close(() => done());
      }),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `check()` holds, or fail after `timeout`. */
async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('condition not met in time');
    await wait(50);
  }
}

describe('RemoteTransport', () => {
  let core: Awaited<ReturnType<typeof fakeCore>> | undefined;
  let link: RemoteTransport | undefined;

  afterEach(async () => {
    link?.stop();
    link = undefined;
    await core?.close();
    core = undefined;
  });

  it('pairs with a code and reports the issued token', async () => {
    core = await fakeCore({ code: '123456' });
    let issued: string | undefined;
    link = new RemoteTransport(
      { onMessage: () => {}, onDown: () => {} },
      { url: core.url, pairingCode: '123456', onPaired: (t) => (issued = t) },
    );
    link.start();

    await until(() => link!.isUp());
    expect(issued).toBe('issued-token'); // caller can now persist it
  });

  it('authenticates with a stored token and serves requests', async () => {
    core = await fakeCore({ token: 'good-token' });
    const seen: CoreMessage[] = [];
    link = new RemoteTransport({ onMessage: (m) => seen.push(m), onDown: () => {} }, { url: core.url, token: 'good-token' });
    link.start();

    await until(() => link!.isUp());
    link.send({ kind: 'req', id: 1, method: 'status' });
    await until(() => seen.some((m) => m.kind === 'res'));
    expect(seen.find((m) => m.kind === 'res')?.result).toEqual({ ok: true });
  });

  it('stops retrying when the core denies the credentials', async () => {
    core = await fakeCore({ token: 'good-token' });
    let denial: string | undefined;
    link = new RemoteTransport(
      { onMessage: () => {}, onDown: () => {} },
      { url: core.url, token: 'wrong', onDenied: (r) => (denial = r) },
    );
    link.start();

    await until(() => denial !== undefined);
    expect(denial).toMatch(/invalid token/);
    // A bad credential can't be fixed by retrying — the link must stay down.
    await wait(1500);
    expect(link.isUp()).toBe(false);
    expect(link.state).toBe('disconnected');
  });

  it('reconnects by itself after the core drops the connection', async () => {
    core = await fakeCore({ token: 'good-token' });
    const downs: string[] = [];
    link = new RemoteTransport({ onMessage: () => {}, onDown: (r) => downs.push(r) }, { url: core.url, token: 'good-token' });
    link.start();
    await until(() => link!.isUp());

    core.dropClients(); // core restarted / tunnel blipped
    await until(() => !link!.isUp());
    expect(downs.length).toBeGreaterThan(0); // in-flight callers were released, not hung

    await until(() => link!.isUp(), 8000); // backoff retry re-authenticated on its own
  });

  it('reports link state transitions for the UI', async () => {
    core = await fakeCore({ token: 'good-token' });
    const states: LinkState[] = [];
    link = new RemoteTransport(
      { onMessage: () => {}, onDown: () => {}, onState: (s) => states.push(s) },
      { url: core.url, token: 'good-token' },
    );
    link.start();
    await until(() => link!.isUp());
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
  });

  it('refuses to send while the link is down', async () => {
    core = await fakeCore({});
    link = new RemoteTransport({ onMessage: () => {}, onDown: () => {} }, { url: core.url, token: 't' });
    // Not started: sending must fail loudly rather than silently dropping the request.
    expect(() => link!.send({ kind: 'req', id: 1, method: 'status' })).toThrow(/not connected/);
  });
});
