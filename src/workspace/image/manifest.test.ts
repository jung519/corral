import { describe, expect, it } from 'vitest';
import { type CollectedManifest, manifestHash } from './manifest.js';

const a: CollectedManifest = { path: 'server/package.json', content: '{"name":"a"}' };
const b: CollectedManifest = { path: 'app/pubspec.yaml', content: 'name: app' };

describe('manifestHash', () => {
  it('is stable regardless of input order', () => {
    expect(manifestHash([a, b], '1')).toBe(manifestHash([b, a], '1'));
  });

  it('changes when a manifest changes', () => {
    const a2 = { ...a, content: '{"name":"a","dep":1}' };
    expect(manifestHash([a, b], '1')).not.toBe(manifestHash([a2, b], '1'));
  });

  it('changes when the template version changes', () => {
    expect(manifestHash([a, b], '1')).not.toBe(manifestHash([a, b], '2'));
  });

  it('returns a short hex id', () => {
    expect(manifestHash([a], '1')).toMatch(/^[0-9a-f]{12}$/);
  });
});
