/**
 * The headless core: where its control plane listens, and that it actually comes up,
 * serves, and stops when told to.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { flag, resolvePlane } from './core-host.js';

describe('flag parsing', () => {
  it('reads a value, and treats a bare flag as present-but-empty', () => {
    expect(flag(['--revoke', 'laptop'], '--revoke')).toBe('laptop');
    expect(flag(['--pair'], '--pair')).toBe('');
    // `--pair --revoke all`: --pair must not swallow the next flag as its value.
    expect(flag(['--pair', '--revoke', 'all'], '--pair')).toBe('');
    expect(flag(['--pair'], '--revoke')).toBeUndefined();
  });
});

describe('where the control plane listens', () => {
  const CONFIG = { enabled: true, host: '10.0.0.5', port: 5000 };

  it('opens on loopback by default when the core has no other way in', () => {
    // Headless with nothing configured — the plane is the only door, so it must open,
    // and on loopback so it is not exposed to the internet by default.
    expect(resolvePlane([], {}, undefined, true)).toEqual({ host: '127.0.0.1', port: 4410 });
  });

  it('stays shut for a desktop core that nobody asked to open it', () => {
    // Process IPC already serves the one trusted client; no port should appear.
    expect(resolvePlane([], {}, undefined, false)).toBeUndefined();
  });

  it('uses the config when it enables the plane', () => {
    expect(resolvePlane([], {}, CONFIG, false)).toEqual({ host: '10.0.0.5', port: 5000 });
  });

  it('lets the flag win over config — config cannot open a plane on a core with no config', () => {
    expect(resolvePlane(['--control-plane', '0.0.0.0:9999'], {}, CONFIG, false)).toEqual({
      host: '0.0.0.0',
      port: 9999,
    });
  });

  it('accepts a bare port and defaults the host to loopback', () => {
    expect(resolvePlane(['--control-plane', '4411'], {}, undefined, false)).toEqual({
      host: '127.0.0.1',
      port: 4411,
    });
  });

  it('falls back to the environment when no flag is given', () => {
    expect(resolvePlane([], { CORRAL_CONTROL_PLANE: '127.0.0.1:4412' }, undefined, false)).toEqual({
      host: '127.0.0.1',
      port: 4412,
    });
  });

  it('refuses an address it cannot parse rather than listening somewhere surprising', () => {
    expect(() => resolvePlane(['--control-plane', 'nonsense'], {}, undefined, true)).toThrow(/invalid/);
    expect(() => resolvePlane(['--control-plane', '127.0.0.1:99999'], {}, undefined, true)).toThrow(/invalid/);
  });
});

describe('the headless process', () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let lastOutput = (): string => '';

  /** Signal the whole group. tsx runs the core in a grandchild, so signalling only the
   *  child we spawned would leave a live process holding the port. */
  function signalGroup(sig: NodeJS.Signals): void {
    if (child?.pid) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    }
  }

  afterEach(() => {
    signalGroup('SIGKILL');
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Start `src/main.ts` with an isolated state dir and no config at all. Port 0 lets the
   *  OS pick one — a fixed port turns any leftover process into a confusing failure. */
  function startHeadless(): { output: () => string; port: () => Promise<number> } {
    dir = mkdtempSync(join(tmpdir(), 'corral-headless-'));
    let output = '';
    child = spawn(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/main.ts', join(dir, 'corral.yaml'), '--control-plane', '0'],
      {
        cwd: process.cwd(),
        env: { ...process.env, CORRAL_STATE_DIR: join(dir, 'state'), CORRAL_DIRECTION_PATH: join(dir, 'direction.md') },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // its own process group, so signalGroup reaches the grandchild
      },
    );
    child.stdout?.on('data', (d: Buffer) => (output += String(d)));
    child.stderr?.on('data', (d: Buffer) => (output += String(d)));
    child.on('error', (err) => (output += `spawn error: ${String(err)}\n`));
    lastOutput = () => output;
    return {
      output: () => output,
      port: async () => Number(await until(() => output.match(/listening on 127\.0\.0\.1:(\d+)/)?.[1])),
    };
  }

  async function until<T>(fn: () => T | undefined, ms = 25_000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out; core said:\n${lastOutput()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('comes up with no config and serves the plane, so setup can happen over it', async () => {
    const { output, port } = startHeadless();

    // No corral.yaml exists — a core that refused to start here could never be configured.
    const code = await until(() => output().match(/pairing code: (\d{6})/)?.[1]);

    const ws = new WebSocket(`ws://127.0.0.1:${await port()}`);
    const inbox: any[] = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))));
    await new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej)));

    ws.send(JSON.stringify({ kind: 'pair', code, label: 'test' }));
    await until(() => inbox.find((m) => m.kind === 'paired'));

    ws.send(JSON.stringify({ kind: 'req', id: 1, method: 'configGet' }));
    const res = await until(() => inbox.find((m) => m.kind === 'res' && m.id === 1));

    expect(res.result).toEqual({ exists: false, yaml: null });
    ws.close();
  }, 40_000);

  it('exits cleanly on SIGTERM instead of being killed', async () => {
    const { output, port } = startHeadless();
    await port();

    const exit = new Promise<{ code: number | null; signal: string | null }>((res) =>
      child!.on('exit', (code, signal) => res({ code, signal })),
    );
    signalGroup('SIGTERM');

    // Exit code 0 by its own hand — not `signal: SIGTERM`, which would mean the default
    // handler killed it before it stopped listening.
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(output()).toContain('SIGTERM received');
  }, 40_000);
});
