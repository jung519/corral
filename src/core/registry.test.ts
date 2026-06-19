import { describe, expect, it } from 'vitest';
import { Registry } from './registry.js';

interface FakeConfig {
  kind: string;
  name: string;
}
interface FakeAdapter {
  id: string;
}

describe('Registry', () => {
  const make = () => new Registry<FakeConfig, FakeAdapter>('tracker');

  it('creates the adapter selected by config.kind', () => {
    const reg = make();
    reg.register('notion', (cfg) => ({ id: `notion:${cfg.name}` }));
    expect(reg.create({ kind: 'notion', name: 'x' }, undefined)).toEqual({ id: 'notion:x' });
  });

  it('throws on unknown kind, listing what is registered', () => {
    const reg = make();
    reg.register('notion', () => ({ id: 'n' }));
    expect(() => reg.create({ kind: 'jira', name: 'y' }, undefined)).toThrow(/unknown tracker adapter kind "jira".*notion/);
  });

  it('throws on duplicate registration', () => {
    const reg = make();
    reg.register('notion', () => ({ id: 'n' }));
    expect(() => reg.register('notion', () => ({ id: 'n2' }))).toThrow(/already registered/);
  });

  it('reports registered kinds', () => {
    const reg = make();
    reg.register('notion', () => ({ id: 'n' }));
    expect(reg.has('notion')).toBe(true);
    expect(reg.has('jira')).toBe(false);
    expect(reg.kinds()).toEqual(['notion']);
  });
});
