import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyStderr, SshTunnel, tunnelArgs, type TunnelStatus } from './tunnel.js';

/**
 * A stand-in ssh: an alive-or-not child, so the supervisor's state machine is exercised
 * without a real ssh (and without needing a reachable server). Readiness still runs
 * against a **real** listening port, because "does the forward carry traffic" is the one
 * thing a fake must not answer for us.
 */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

function fakeSpawn(children: FakeChild[]): typeof spawn {
  return ((..._args: unknown[]) => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
}

/** A port something is listening on, so the readiness probe can succeed. */
async function listeningPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as { port: number };
  return { port, server };
}

/** A port nothing is listening on — bind then release, so it is very likely free. */
async function freePort(): Promise<number> {
  const { port, server } = await listeningPort();
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('tunnelArgs', () => {
  const cfg = { target: 'me@box', remotePort: 4410, localPort: 4410 };

  it('forwards the local port to the remote loopback', () => {
    expect(tunnelArgs(cfg)).toContain('4410:127.0.0.1:4410');
  });

  it('refuses to stay up when the forward fails', () => {
    // Without this, ssh being alive would tell us nothing about the tunnel working.
    expect(tunnelArgs(cfg).join(' ')).toContain('ExitOnForwardFailure=yes');
  });

  it('never prompts', () => {
    // A spawned ssh asking for a passphrase would hang with nothing to type into.
    expect(tunnelArgs(cfg).join(' ')).toContain('BatchMode=yes');
  });

  it('notices a link killed by sleep or a network change', () => {
    expect(tunnelArgs(cfg).join(' ')).toContain('ServerAliveInterval=30');
  });

  it('puts the destination last and pins the key when one is given', () => {
    const args = tunnelArgs({ ...cfg, identityFile: '/k/id' });
    expect(args.at(-1)).toBe('me@box');
    expect(args.join(' ')).toContain('-i /k/id');
    expect(args.join(' ')).toContain('IdentitiesOnly=yes');
  });

  it('maps differing ports', () => {
    expect(tunnelArgs({ ...cfg, localPort: 5555, remotePort: 4410 })).toContain('5555:127.0.0.1:4410');
  });
});

describe('classifyStderr', () => {
  it('treats a rejected key as fatal — retrying cannot fix it', () => {
    expect(classifyStderr('me@box: Permission denied (publickey).')).toEqual({
      code: 'auth-failed',
      fatal: true,
    });
  });

  it('treats a busy local port as fatal', () => {
    expect(classifyStderr('bind: Address already in use\ncannot listen to port: 4410')).toEqual({
      code: 'forward-failed',
      fatal: true,
    });
  });

  it('leaves anything else retryable', () => {
    expect(classifyStderr('kex_exchange_identification: read: Connection reset')).toEqual({
      code: 'exited',
      fatal: false,
    });
  });
});

describe('SshTunnel', () => {
  let tunnel: SshTunnel | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    tunnel?.stop();
    tunnel = undefined;
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
  });

  it('is up only once the local port actually accepts', async () => {
    const listener = await listeningPort();
    server = listener.server;
    const seen: TunnelStatus[] = [];
    const children: FakeChild[] = [];

    tunnel = new SshTunnel(
      { onStatus: (s) => seen.push(s) },
      { target: 'me@box', remotePort: 4410, localPort: listener.port },
      fakeSpawn(children),
    );
    tunnel!.start();

    expect(seen[0]!.state).toBe('starting');
    expect(tunnel!.isUp).toBe(false);

    await wait(600);
    expect(tunnel!.isUp).toBe(true);
    expect(seen.at(-1)!.state).toBe('up');
  });

  it('stays in starting while nothing listens — an alive ssh is not a working tunnel', async () => {
    const port = await freePort();
    const children: FakeChild[] = [];

    tunnel = new SshTunnel(
      { onStatus: () => {} },
      { target: 'me@box', remotePort: 4410, localPort: port },
      fakeSpawn(children),
    );
    tunnel!.start();

    await wait(600);
    expect(tunnel!.status.state).toBe('starting');
    expect(tunnel!.isUp).toBe(false);
  });

  it('names a missing ssh instead of failing blankly, and does not retry', async () => {
    const children: FakeChild[] = [];
    const spawnFn = fakeSpawn(children);
    tunnel = new SshTunnel({ onStatus: () => {} }, { target: 'me@box', remotePort: 4410, localPort: 4410 }, spawnFn);
    tunnel!.start();

    const err = new Error('spawn ssh ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    children[0]!.emit('error', err);

    expect(tunnel!.status).toMatchObject({ state: 'failed', code: 'ssh-not-found', fatal: true });

    // A fatal cause must not be buried under an endless retry loop.
    await wait(1_400);
    expect(children).toHaveLength(1);
  });

  it('reports a rejected key and stops trying', async () => {
    const children: FakeChild[] = [];
    tunnel = new SshTunnel(
      { onStatus: () => {} },
      { target: 'me@box', remotePort: 4410, localPort: 4410 },
      fakeSpawn(children),
    );
    tunnel!.start();

    children[0]!.stderr.emit('data', Buffer.from('me@box: Permission denied (publickey).'));
    children[0]!.emit('exit', 255, null);

    expect(tunnel!.status).toMatchObject({ state: 'failed', code: 'auth-failed', fatal: true });
    expect(tunnel.status.detail).toContain('Permission denied');
    await wait(1_400);
    expect(children).toHaveLength(1);
  });

  it('retries a transient exit', async () => {
    const children: FakeChild[] = [];
    tunnel = new SshTunnel(
      { onStatus: () => {} },
      { target: 'me@box', remotePort: 4410, localPort: 4410 },
      fakeSpawn(children),
    );
    tunnel!.start();

    children[0]!.stderr.emit('data', Buffer.from('Connection reset by peer'));
    children[0]!.emit('exit', 255, null);
    expect(tunnel!.status).toMatchObject({ state: 'failed', fatal: false });

    await wait(1_400);
    expect(children.length).toBeGreaterThan(1);
  });

  it('leaves no ssh behind when stopped — an orphan would hold the port', async () => {
    const children: FakeChild[] = [];
    tunnel = new SshTunnel(
      { onStatus: () => {} },
      { target: 'me@box', remotePort: 4410, localPort: 4410 },
      fakeSpawn(children),
    );
    tunnel!.start();
    tunnel!.stop();

    expect(children[0]!.killed).toBe(true);
    expect(tunnel!.status.state).toBe('off');
  });
});
