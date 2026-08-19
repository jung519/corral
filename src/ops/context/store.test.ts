/**
 * The store exists so two ends of one turn read one fetch. So the questions here are: does
 * it fetch at all, does it stop fetching, and — the one that matters — does the prompt end
 * and the checking end get the same list (CRL-64).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextStore } from './store.js';
import { StoreContextResolver } from './resolver.js';
import { RuleAnswerValidator } from '../validate/rules.js';
import { PipelineSchema, type PipelineAgentStep } from '../pipeline/schema.js';

afterEach(() => vi.unstubAllGlobals());

/** A list endpoint that counts how often it is asked and can be told to change its answer. */
function stubList(pages: unknown[]): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = pages[Math.min(calls, pages.length - 1)];
      calls++;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { calls: () => calls };
}

const SOURCE = { source: { method: 'GET' as const, url: 'https://host/vocab', headers: {}, timeout_ms: 5000, auth: { header: 'authorization', prefix: 'Bearer ' } }, select: 'values' };

function step(extra: Record<string, unknown>): PipelineAgentStep {
  return PipelineSchema.parse({
    key: 'p',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: {
      prompt: { system: 's', user_template: 'u' },
      schema: { type: 'object', properties: { items: { type: 'array' } } },
      ...extra,
    },
    output: { kind: 'none' },
  }).agent;
}

describe('a list written into the definition', () => {
  it('needs no request', async () => {
    const asked = stubList([]);

    expect(await new ContextStore().list({ values: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(asked.calls()).toBe(0);
  });
});

describe('a list that has to be fetched', () => {
  it('comes back in the order it arrived', async () => {
    stubList([{ values: ['b', 'a', 'c'] }]);

    // Not a Set: a prompt reads a list, and the order a source chose is information.
    expect(await new ContextStore().list(SOURCE)).toEqual(['b', 'a', 'c']);
  });

  it('is fetched once for a run of them', async () => {
    const asked = stubList([{ values: ['a'] }]);
    const store = new ContextStore();

    // Sequential, which is what the guarantee is: the cache is written when a fetch
    // returns, so calls that overlap in flight each make their own request. A pipeline
    // runs its own turns one at a time (`max_concurrent` defaults to 1), and within one
    // turn the prompt end and the checking end are strictly ordered — so overlap needs two
    // pipelines starting on the same list at the same moment. Not free, but not this test.
    for (let i = 0; i < 5; i++) await store.list(SOURCE);

    expect(asked.calls()).toBe(1);
  });

  it('is fetched again once the cached copy is old', async () => {
    const asked = stubList([{ values: ['a'] }, { values: ['a', 'b'] }]);
    let clock = 0;
    const store = new ContextStore({ now: () => clock, ttlMs: 1000 });

    await store.list(SOURCE);
    clock = 1500;
    expect(await store.list(SOURCE)).toEqual(['a', 'b']);
    expect(asked.calls()).toBe(2);
  });

  it('refuses when what came back is not a list', async () => {
    stubList([{ values: { a: 1 } }]);

    await expect(new ContextStore().list(SOURCE)).rejects.toThrow('expected a list');
  });
});

describe('the prompt end and the checking end', () => {
  it('read one fetch, so they cannot disagree about the list', async () => {
    const asked = stubList([{ values: ['news', 'sport'] }]);
    const lists = new ContextStore();
    const resolver = new StoreContextResolver(lists);
    const validator = new RuleAnswerValidator({ store: lists });
    const s = step({ context: { allowed: SOURCE }, validate: { allowed_values: { field: 'items', ...SOURCE } } });

    const material = await resolver.resolve(s);
    const verdict = await validator.check(s, { items: ['news', 'invented'] });

    expect(material).toEqual({ allowed: ['news', 'sport'] });
    expect(verdict).toMatchObject({ ok: true, answer: { items: ['news'] } });
    // The whole point: one call, so what the model was shown is what it was judged against.
    expect(asked.calls()).toBe(1);
  });
});

describe('a pipeline with several lists', () => {
  it('names the one that could not be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const resolver = new StoreContextResolver(new ContextStore());

    await expect(resolver.resolve(step({ context: { allowed: SOURCE } }))).rejects.toThrow('context "allowed"');
  });

  it('resolves nothing when nothing is declared', async () => {
    const asked = stubList([]);

    expect(await new StoreContextResolver(new ContextStore()).resolve(step({}))).toEqual({});
    expect(asked.calls()).toBe(0);
  });
});
