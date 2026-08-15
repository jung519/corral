/**
 * Which machine each native capability lands on. The whole feature is this decision,
 * so it is asserted directly rather than through the Electron IPC layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as native from './native-routing.js';

// vi.mock factories run before the module body, so the state they close over has to be
// hoisted with them.
const h = vi.hoisted(() => ({
  mode: 'local' as 'local' | 'remote',
  coreDown: false,
  coreResult: {} as unknown,
  coreCalls: [] as Array<{ method: string; args?: Record<string, unknown> }>,
  localCalls: [] as string[],
}));

vi.mock('./remote-store.js', () => ({ readRemote: () => ({ mode: h.mode }) }));
vi.mock('./core-link/index.js', () => ({
  callCore: async (method: string, args?: Record<string, unknown>) => {
    h.coreCalls.push({ method, args });
    if (h.coreDown) throw new Error('orchestrator not running');
    return h.coreResult;
  },
}));
vi.mock('./config-store.js', () => ({
  configExists: () => (h.localCalls.push('configExists'), true),
  readConfig: () => (h.localCalls.push('readConfig'), 'local: yaml'),
  writeConfig: (yaml: string) => void h.localCalls.push(`writeConfig(${yaml})`),
}));
vi.mock('./keychain.js', () => ({
  setSecret: (s: string, a: string, v: string) => void h.localCalls.push(`setSecret(${s},${a},${v})`),
  hasSecret: () => (h.localCalls.push('hasSecret'), true),
  deleteSecret: () => void h.localCalls.push('deleteSecret'),
}));
vi.mock('./draft-store.js', () => ({
  readDraft: () => (h.localCalls.push('readDraft'), 'local draft'),
  writeDraft: () => void h.localCalls.push('writeDraft'),
  clearDraft: () => void h.localCalls.push('clearDraft'),
}));
vi.mock('./direction-store.js', () => ({
  readDirection: () => (h.localCalls.push('readDirection'), 'local direction'),
  writeDirection: () => void h.localCalls.push('writeDirection'),
}));

beforeEach(() => {
  h.mode = 'local';
  h.coreDown = false;
  h.coreResult = {};
  h.coreCalls.length = 0;
  h.localCalls.length = 0;
});

describe('local mode', () => {
  it('never asks the core for anything the desktop already owns', async () => {
    await native.configExists();
    await native.configRead();
    await native.configWrite('a: 1');
    await native.secretSet('notion', 'default', 'tok');
    await native.secretHas('notion', 'default');
    await native.draftRead();
    await native.directionRead();

    expect(h.coreCalls).toEqual([]);
    expect(h.localCalls).toContain('configExists');
    expect(h.localCalls).toContain('setSecret(notion,default,tok)');
  });

  it('reports a config save as done — there is no remote reload to fail', async () => {
    expect(await native.configWrite('a: 1')).toEqual({ ok: true });
  });
});

describe('remote mode', () => {
  beforeEach(() => (h.mode = 'remote'));

  it('sends config, secrets, direction and draft to the core, not to this disk', async () => {
    h.coreResult = { exists: true, yaml: 'remote: yaml', has: true, json: 'remote draft', text: 'remote direction' };

    expect(await native.configRead()).toBe('remote: yaml');
    expect(await native.secretHas('notion', 'default')).toBe(true);
    expect(await native.draftRead()).toBe('remote draft');
    expect(await native.directionRead()).toBe('remote direction');
    await native.secretSet('notion', 'default', 'tok');

    expect(h.localCalls).toEqual([]);
    expect(h.coreCalls.map((c) => c.method)).toEqual(['configGet', 'secretHas', 'draftGet', 'direction', 'secretSet']);
  });

  it('passes the core reload verdict back instead of claiming the save worked', async () => {
    h.coreResult = { ok: false, error: 'tracker unreachable' };

    expect(await native.configWrite('a: 1')).toEqual({ ok: false, error: 'tracker unreachable' });
  });

  it('asks the core whether Docker is there — the containers run on its machine', async () => {
    h.coreResult = { available: true, version: 'Docker version 29' };

    expect(await native.detectDocker()).toEqual({ available: true, version: 'Docker version 29' });
    expect(h.coreCalls.map((c) => c.method)).toEqual(['detectDocker']);
  });
});

describe('when the remote link is down', () => {
  beforeEach(() => {
    h.mode = 'remote';
    h.coreDown = true;
  });

  it('still claims a config exists, so a blip does not throw the user into the wizard', async () => {
    expect(await native.configExists()).toBe(true);
  });

  it('answers the other reads conservatively instead of breaking the screen', async () => {
    expect(await native.configRead()).toBe(null);
    expect(await native.secretHas('notion', 'default')).toBe(false);
    expect(await native.draftRead()).toBe(null);
    expect(await native.directionRead()).toBe('');
    expect(await native.detectDocker()).toEqual({ available: false });
    expect(await native.detectCli('claude')).toEqual({ installed: false });
  });

  it('lets writes fail loudly — a save that did not happen must say so', async () => {
    await expect(native.configWrite('a: 1')).rejects.toThrow();
    await expect(native.secretSet('notion', 'default', 'tok')).rejects.toThrow();
    await expect(native.directionWrite('x')).rejects.toThrow();
  });
});
