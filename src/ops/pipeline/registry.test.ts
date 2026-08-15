import { describe, expect, it } from 'vitest';
import { PipelineRegistry } from './registry.js';
import { PipelineSchema, type Pipeline } from './schema.js';

const make = (key: string, enabled = true): Pipeline =>
  PipelineSchema.parse({
    key,
    enabled,
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: {} } },
    output: { kind: 'none' },
  });

describe('the registry', () => {
  it('lists everything but runs only what is enabled', () => {
    const r = new PipelineRegistry();
    r.register(make('a'));
    r.register(make('b', false));

    expect(r.all().map((p) => p.key)).toEqual(['a', 'b']);
    expect(r.active().map((p) => p.key)).toEqual(['a']); // the UI needs both lists
  });

  it('replaces a definition registered under the same key', () => {
    const r = new PipelineRegistry();
    r.register(make('a'));
    r.register({ ...make('a'), description: 'edited' });

    expect(r.size).toBe(1);
    expect(r.get('a')?.description).toBe('edited');
  });

  it('keeps a runtime toggle across a reload of the definitions', () => {
    const r = new PipelineRegistry();
    r.replaceAll([make('a'), make('b')]);
    r.setEnabled('a', false);

    r.replaceAll([make('a'), make('b')]); // e.g. someone edited b's file

    // Re-reading files must not quietly restart something an operator turned off.
    expect(r.active().map((p) => p.key)).toEqual(['b']);
  });

  it('forgets the toggle for a pipeline that is gone', () => {
    const r = new PipelineRegistry();
    r.replaceAll([make('a')]);
    r.setEnabled('a', false);

    r.replaceAll([]);
    r.replaceAll([make('a')]); // added back later, freshly

    expect(r.isEnabled('a')).toBe(true);
  });

  it('cannot switch on something its own file disabled', () => {
    const r = new PipelineRegistry();
    r.register(make('a', false));

    // The runtime toggle suppresses; it does not override what the operator wrote.
    expect(r.setEnabled('a', true)).toBe(false);
    expect(r.isEnabled('a')).toBe(false);
  });

  it('says so for a key it does not have', () => {
    const r = new PipelineRegistry();

    expect(r.get('nope')).toBeUndefined();
    expect(r.isEnabled('nope')).toBe(false);
    expect(r.setEnabled('nope', true)).toBe(false);
  });
});
