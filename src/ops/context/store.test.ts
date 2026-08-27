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

describe('a rule that judges against what the prompt was shown', () => {
  const withFrom = {
    context: { allowed: SOURCE },
    validate: { allowed_values: { field: 'items', from: 'allowed' } },
  };

  it('uses the resolved list, and the URL is written once', async () => {
    const asked = stubList([{ values: ['news', 'sport'] }]);
    const lists = new ContextStore();
    const s = step(withFrom);

    const material = await new StoreContextResolver(lists).resolve(s);
    const verdict = await new RuleAnswerValidator({ store: lists }).check(s, { items: ['news', 'invented'] }, material);

    expect(verdict).toMatchObject({ ok: true, answer: { items: ['news'] } });
    // One declaration, one request — the whole point of `from`.
    expect(asked.calls()).toBe(1);
  });

  it('judges against the list, not against a field that shadowed its name', async () => {
    stubList([{ values: ['news', 'sport'] }]);
    const lists = new ContextStore();
    const s = step(withFrom);
    const resolved = await new StoreContextResolver(lists).resolve(s);

    // What `run.ts` builds for the prompt: a context name is the weakest in the bag, so an
    // event field of the same name wins there. The check must NOT read that version — a
    // value that arrived on a queue message is not the controlled vocabulary.
    const merged = { ...resolved, allowed: ['whatever-the-caller-sent'] };
    expect(merged.allowed).not.toEqual(resolved.allowed);

    const verdict = await new RuleAnswerValidator({ store: lists }).check(s, { items: ['news'] }, resolved);

    expect(verdict).toMatchObject({ ok: true, answer: { items: ['news'] } });
  });

  it('refuses when the resolved context never arrived', async () => {
    stubList([{ values: ['news'] }]);
    const s = step(withFrom);

    // A wiring fault, not a definition one — the schema already refuses a `from` that names
    // nothing. Saying so beats treating "no list" as "nothing is allowed".
    const verdict = await new RuleAnswerValidator().check(s, { items: ['news'] }, {});

    expect(verdict).toMatchObject({ ok: false, reasons: [expect.stringContaining('was not resolved')] });
  });
});

describe('a vocabulary that arrives nested', () => {
  // The shape a real endpoint answered with, which is what CRL-70 was for: the values to
  // classify against are the child keys, and a plain dotted path cannot reach them.
  const NESTED = {
    majors: [
      { key: 'FOOD', label: '\uba39\uac70\ub9ac', minors: [{ key: 'BUNSIK' }, { key: 'FRUIT' }] },
      { key: 'ACTIVITY', label: '\uccb4\ud5d8', minors: [{ key: 'CRAFT' }] },
    ],
  };
  const spec = { ...SOURCE, select: 'majors[].minors[].key' };
  const withFrom = {
    context: { allowed: spec },
    validate: { allowed_values: { field: 'items', from: 'allowed' } },
  };

  it('flattens to the child keys the prompt and the check both need', async () => {
    stubList([NESTED]);
    const lists = new ContextStore();

    const material = await new StoreContextResolver(lists).resolve(step(withFrom));

    expect(material).toEqual({ allowed: ['BUNSIK', 'FRUIT', 'CRAFT'] });
  });

  it('judges an answer against them, keeping the good and dropping the invented', async () => {
    stubList([NESTED]);
    const lists = new ContextStore();
    const s = step(withFrom);

    const material = await new StoreContextResolver(lists).resolve(s);
    const verdict = await new RuleAnswerValidator({ store: lists }).check(s, { items: ['BUNSIK', 'INVENTED'] }, material);

    // Before this, `select: "majors"` handed the check a list of records, every value was
    // dropped, and the run ended `rejected` with nothing to show.
    expect(verdict).toMatchObject({ ok: true, answer: { items: ['BUNSIK'] }, dropped: ['items: INVENTED'] });
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
