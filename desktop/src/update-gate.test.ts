import { describe, expect, it } from 'vitest';
import { compareSemver, decideGate } from './update-gate.js';

describe('compareSemver', () => {
  it('orders by major, minor, patch', () => {
    expect(compareSemver('1.2.0', '1.2.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.3.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.2.10', '1.2.9')).toBe(1); // numeric, not lexical
  });
  it('tolerates a v prefix and pre-release/build metadata', () => {
    expect(compareSemver('v1.2.0', '1.2.0')).toBe(0);
    expect(compareSemver('1.2.0-beta', '1.2.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.0')).toBe(0); // missing patch → 0
  });
  it('throws on a non-numeric core', () => {
    expect(() => compareSemver('abc', '1.0.0')).toThrow();
  });
});

describe('decideGate', () => {
  const m = { minSupported: '1.2.0', recommended: '1.4.0', downloadUrl: 'https://x', notice: 'fix' };

  it('forces below minSupported', () => {
    const d = decideGate('1.1.0', m);
    expect(d.kind).toBe('forced');
    expect(d.target).toBe('1.2.0');
    expect(d.downloadUrl).toBe('https://x');
  });
  it('recommends between minSupported and recommended', () => {
    expect(decideGate('1.3.0', m).kind).toBe('recommended');
    expect(decideGate('1.2.0', m).kind).toBe('recommended'); // == minSupported, < recommended
  });
  it('passes at or above recommended', () => {
    expect(decideGate('1.4.0', m).kind).toBe('ok');
    expect(decideGate('2.0.0', m).kind).toBe('ok');
  });
  it('fails OPEN: no manifest, empty manifest, or unparseable current → ok', () => {
    expect(decideGate('1.0.0', null).kind).toBe('ok');
    expect(decideGate('1.0.0', {}).kind).toBe('ok');
    expect(decideGate('not-a-version', m).kind).toBe('ok'); // never brick on a bad version
  });
  it('an all-0.0.0 manifest blocks nobody', () => {
    expect(decideGate('0.0.0', { minSupported: '0.0.0', recommended: '0.0.0' }).kind).toBe('ok');
  });
});
