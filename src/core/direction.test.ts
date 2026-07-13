import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectionStore } from './direction.js';

describe('DirectionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corral-direction-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns '' when the file does not exist", () => {
    const store = new DirectionStore(join(dir, 'direction.md'));
    expect(store.read()).toBe('');
  });

  it('reads existing content', () => {
    const path = join(dir, 'direction.md');
    writeFileSync(path, '# 목적\n안정 우선', 'utf8');
    expect(new DirectionStore(path).read()).toBe('# 목적\n안정 우선');
  });

  it('write → read round-trips and creates missing parent dirs', () => {
    const path = join(dir, 'nested', 'direction.md');
    const store = new DirectionStore(path);
    store.write('우선순위: 안정 > 속도');
    expect(store.read()).toBe('우선순위: 안정 > 속도');
  });

  it('reads fresh from disk each call (no cache)', () => {
    const path = join(dir, 'direction.md');
    const store = new DirectionStore(path);
    store.write('v1');
    expect(store.read()).toBe('v1');
    writeFileSync(path, 'v2', 'utf8');
    expect(store.read()).toBe('v2');
  });

  it('exposes the resolved absolute path', () => {
    const store = new DirectionStore(join(dir, 'direction.md'));
    expect(store.path).toBe(join(dir, 'direction.md'));
  });

  // The desktop integration contract: the core spawns with cwd = userData and constructs
  // DirectionStore() with no arg, so the default 'direction.md' must resolve to
  // <cwd>/direction.md — the same file the desktop bridge writes (userData/direction.md).
  it('default path resolves to <cwd>/direction.md', () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const store = new DirectionStore();
      store.write('cwd-relative');
      expect(store.read()).toBe('cwd-relative');
      // Compare against the post-chdir cwd (macOS resolves /tmp → /private/tmp symlinks).
      expect(store.path).toBe(join(process.cwd(), 'direction.md'));
    } finally {
      process.chdir(cwd);
    }
  });
});
