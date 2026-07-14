import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectionCheckStore, directionHash, DirectionStore, parseDirectionVerdict } from './direction.js';

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

describe('directionHash', () => {
  it('ignores surrounding whitespace but not content', () => {
    expect(directionHash('  hello \n')).toBe(directionHash('hello'));
    expect(directionHash('hello')).not.toBe(directionHash('hello!'));
  });
});

describe('DirectionCheckStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corral-check-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to no consent and nothing verified', () => {
    const s = new DirectionCheckStore(dir);
    expect(s.getConsent()).toBe(false);
    expect(s.isVerified('global', 'x')).toBe(false);
  });

  it('persists consent across instances', () => {
    new DirectionCheckStore(dir).setConsent(true);
    expect(new DirectionCheckStore(dir).getConsent()).toBe(true);
  });

  it('verifies a scope by exact text; any edit invalidates it', () => {
    const s = new DirectionCheckStore(dir);
    s.markVerified('global', 'stability first');
    expect(s.isVerified('global', 'stability first')).toBe(true);
    expect(s.isVerified('global', 'stability first!')).toBe(false); // edited → re-check
  });

  it('keeps the verified hash when consent is toggled (independent fields)', () => {
    const s = new DirectionCheckStore(dir);
    s.markVerified('global', 'A');
    s.setConsent(true);
    expect(s.isVerified('global', 'A')).toBe(true);
    expect(s.getConsent()).toBe(true);
  });
});

describe('parseDirectionVerdict', () => {
  it('parses a clean verdict', () => {
    expect(parseDirectionVerdict('{"approved": true, "reason": "ok"}')).toEqual({ approved: true, reason: 'ok' });
  });
  it('extracts JSON wrapped in prose / code fences', () => {
    expect(parseDirectionVerdict('Here:\n```json\n{"approved": false, "reason": "abuse"}\n```')).toEqual({
      approved: false,
      reason: 'abuse',
    });
  });
  it('returns null for missing / non-boolean / unparseable input', () => {
    expect(parseDirectionVerdict(null)).toBeNull();
    expect(parseDirectionVerdict('')).toBeNull();
    expect(parseDirectionVerdict('no json here')).toBeNull();
    expect(parseDirectionVerdict('{"approved": "yes"}')).toBeNull();
    expect(parseDirectionVerdict('{approved: true}')).toBeNull();
  });
  it('defaults reason to empty string when absent', () => {
    expect(parseDirectionVerdict('{"approved": true}')).toEqual({ approved: true, reason: '' });
  });
});
