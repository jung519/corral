/**
 * Whether changing one setting keeps the others.
 *
 * This file exists because it did not. `writeRemote` took the whole record and overwrote
 * the file, so the renderer switching to `local` — which passes nothing else — wrote the
 * remote setup away: `url` and `tunnel` were simply gone from disk, and coming back meant
 * re-typing the server, the ports and the key path (CRL-119). The loss was one click; the
 * recovery was several plus values nobody had written down.
 *
 * So the rule under test is narrow: absent means unchanged, and erasing has to be asked
 * for by name.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRemote, readRemote, writeRemote } from './remote-store.js';

// vi.mock factories run before the module body, so the state they close over is hoisted.
const h = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));
vi.mock('./keychain.js', () => ({
  getSecret: () => null,
  setSecret: () => {},
  deleteSecret: () => {},
}));

const file = (): string => join(h.dir, 'remote.json');
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(file(), 'utf8'));

const TUNNEL = { target: 'me@box', remotePort: 4410, localPort: 4410 };

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'corral-remote-'));
});
afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

describe('changing one setting', () => {
  it('keeps the rest — the regression this file is named for', () => {
    writeRemote({ mode: 'remote', url: 'ws://127.0.0.1:4410', tunnel: TUNNEL });

    writeRemote({ mode: 'local' }); // what the renderer does when you pick "this computer"

    const after = readRemote();
    expect(after.mode).toBe('local');
    expect(after.url).toBe('ws://127.0.0.1:4410');
    expect(after.tunnel).toEqual(TUNNEL);
  });

  it('survives the round trip, so switching back needs nothing retyped', () => {
    writeRemote({ mode: 'remote', url: 'ws://127.0.0.1:4410', tunnel: TUNNEL });
    writeRemote({ mode: 'local' });
    writeRemote({ mode: 'remote' });

    expect(readRemote()).toMatchObject({ mode: 'remote', url: 'ws://127.0.0.1:4410', tunnel: TUNNEL });
  });

  it('ignores an absent value even when the key is there', () => {
    // The IPC handler always builds `{ mode, url, label, tunnel }`, so merging cannot key
    // off presence — only the value says whether the caller meant anything.
    writeRemote({ mode: 'remote', url: 'ws://a:1', tunnel: TUNNEL });

    writeRemote({ mode: 'remote', url: undefined, label: undefined, tunnel: undefined });

    expect(readRemote()).toMatchObject({ url: 'ws://a:1', tunnel: TUNNEL });
  });

  it('does overwrite a value that was given', () => {
    writeRemote({ mode: 'remote', url: 'ws://a:1' });
    writeRemote({ url: 'ws://b:2' });
    expect(readRemote().url).toBe('ws://b:2');
  });

  it('writes no null placeholders — the file is read by people too', () => {
    writeRemote({ mode: 'local' });
    expect(Object.values(onDisk())).not.toContain(null);
    expect(onDisk()).toEqual({ mode: 'local' });
  });
});

describe('erasing', () => {
  it('happens only when asked for by name', () => {
    writeRemote({ mode: 'remote', url: 'ws://127.0.0.1:4410', tunnel: TUNNEL });

    clearRemote();

    const after = readRemote();
    expect(after.mode).toBe('local');
    expect(after.url).toBeUndefined();
    expect(after.tunnel).toBeUndefined();
  });
});

describe('reading', () => {
  it('falls back to local when there is no file', () => {
    expect(readRemote().mode).toBe('local');
  });

  it('falls back to local on a corrupt file rather than throwing', () => {
    writeFileSync(file(), '{ not json', 'utf8');
    expect(() => readRemote()).not.toThrow();
    expect(readRemote().mode).toBe('local');
  });

  it('treats any mode other than remote as local', () => {
    writeFileSync(file(), JSON.stringify({ mode: 'sideways' }), 'utf8');
    expect(readRemote().mode).toBe('local');
  });
});
