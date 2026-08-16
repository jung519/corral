/**
 * The rules exist because a prompt is a request, not a guarantee. So the question in
 * every test here is the same: if the model ignores the instruction, does the code still
 * stop the bad value from reaching the user's system?
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineSchema, type PipelineAgentStep } from '../pipeline/schema.js';
import { RuleAnswerValidator } from './rules.js';

function step(validate: Record<string, unknown>): PipelineAgentStep {
  return PipelineSchema.parse({
    key: 'p',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: {
      prompt: { system: 's', user_template: 'u' },
      schema: {
        type: 'object',
        properties: { items: { type: 'array' }, confidence: { type: 'number' } },
      },
      validate,
    },
    output: { kind: 'none' },
  }).agent;
}

afterEach(() => vi.unstubAllGlobals());

/** A vocabulary endpoint that counts how often it is asked. */
function stubVocabulary(payload: unknown): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return { calls: () => calls };
}

describe('values outside the allowed list', () => {
  const rule = { allowed_values: { field: 'items', values: ['news', 'sport'] } };

  it('drops them and records what was dropped', async () => {
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step(rule), { items: ['news', 'invented', 'sport'] });

    expect(verdict).toMatchObject({ ok: true, answer: { items: ['news', 'sport'] } });
    // Recorded so an operator can see a model drifting, rather than silently losing values.
    expect(verdict.ok && verdict.dropped).toEqual(['items: invented']);
  });

  it('leaves a clean answer untouched and reports nothing dropped', async () => {
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step(rule), { items: ['news'] });

    expect(verdict).toEqual({ ok: true, answer: { items: ['news'] }, dropped: undefined });
  });

  it('handles a single value as well as a list', async () => {
    const v = new RuleAnswerValidator();

    expect(await v.check(step(rule), { items: 'news' })).toMatchObject({ answer: { items: 'news' } });
    expect(await v.check(step(rule), { items: 'invented' })).toMatchObject({ answer: { items: null } });
  });

  it('says nothing about a field the model did not answer with', async () => {
    const v = new RuleAnswerValidator();

    expect(await v.check(step(rule), { confidence: 1 })).toMatchObject({ ok: true, answer: { confidence: 1 } });
  });
});

describe('an allowed list that has to be fetched', () => {
  const rule = {
    allowed_values: { field: 'items', source: { url: 'https://example.test/vocabulary' }, select: 'data.values' },
  };

  it('uses it', async () => {
    stubVocabulary({ data: { values: ['news', 'sport'] } });
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step(rule), { items: ['news', 'invented'] });

    expect(verdict).toMatchObject({ ok: true, answer: { items: ['news'] } });
  });

  it('fetches it once for a burst of runs', async () => {
    const vocab = stubVocabulary({ data: { values: ['news'] } });
    const v = new RuleAnswerValidator({ now: () => 1000 });

    for (let i = 0; i < 5; i++) await v.check(step(rule), { items: ['news'] });

    // At operational volume this is thousands of runs a day; a list that changes daily
    // does not need fetching for each one.
    expect(vocab.calls()).toBe(1);
  });

  it('fetches again once the cached copy is old', async () => {
    const vocab = stubVocabulary({ data: { values: ['news'] } });
    let clock = 1000;
    const v = new RuleAnswerValidator({ now: () => clock, ttlMs: 60_000 });

    await v.check(step(rule), { items: ['news'] });
    clock += 61_000;
    await v.check(step(rule), { items: ['news'] });

    expect(vocab.calls()).toBe(2);
  });

  it('refuses the answer when the list cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step(rule), { items: ['news'] });

    // Without the list there is no way to tell a good value from a bad one. Passing the
    // answer through would defeat the rule at exactly the moment it matters.
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reasons[0]).toMatch(/could not load the allowed values for "items"/);
  });

  it('refuses when what came back is not a list', async () => {
    stubVocabulary({ data: { values: { news: true } } });
    const v = new RuleAnswerValidator();

    expect((await v.check(step(rule), { items: ['news'] })).ok).toBe(false);
  });
});

describe('more items than asked for', () => {
  it('cuts the extras and records them', async () => {
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step({ max_items: { field: 'items', limit: 2 } }), {
      items: ['a', 'b', 'c', 'd'],
    });

    expect(verdict).toMatchObject({ ok: true, answer: { items: ['a', 'b'] } });
    expect(verdict.ok && verdict.dropped).toEqual(['items: c', 'items: d']);
  });

  it('leaves a list that is already within the limit alone', async () => {
    const v = new RuleAnswerValidator();

    expect(await v.check(step({ max_items: { field: 'items', limit: 4 } }), { items: ['a'] })).toEqual({
      ok: true,
      answer: { items: ['a'] },
      dropped: undefined,
    });
  });

  it('caps what survived the allowed list, not what the model sent', async () => {
    const v = new RuleAnswerValidator();
    const rules = {
      allowed_values: { field: 'items', values: ['a', 'b', 'c'] },
      max_items: { field: 'items', limit: 2 },
    };

    const verdict = await v.check(step(rules), { items: ['x', 'a', 'y', 'b', 'c'] });

    // Order matters: filtering first means the limit applies to real values, so two bad
    // ones can't push a good one out.
    expect(verdict).toMatchObject({ answer: { items: ['a', 'b'] } });
  });
});

describe('the model being unsure', () => {
  const rule = { min_confidence: { field: 'confidence', threshold: 0.7 } };

  it('is reported as low confidence, not as a rejection', async () => {
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step(rule), { items: ['news'], confidence: 0.4 });

    // The answer is well-formed, just doubtful. What happens next is the pipeline's
    // `on_low_confidence` decision, and it needs the answer to be able to send it.
    expect(verdict).toMatchObject({ ok: false, lowConfidence: true, answer: { items: ['news'] } });
    expect(!verdict.ok && verdict.reasons[0]).toMatch(/confidence 0.4 is below the 0.7 threshold/);
  });

  it('passes at exactly the threshold', async () => {
    const v = new RuleAnswerValidator();

    expect((await v.check(step(rule), { confidence: 0.7 })).ok).toBe(true);
  });

  it('refuses when there is no number to check', async () => {
    const v = new RuleAnswerValidator();

    // Treating a missing confidence as "confident enough" would silently disable the rule
    // the pipeline explicitly asked for.
    const verdict = await v.check(step(rule), { items: ['news'] });

    expect(verdict).toMatchObject({ ok: false });
    expect('lowConfidence' in verdict).toBe(false);
  });

  it('carries the cleaned answer, not the raw one', async () => {
    const v = new RuleAnswerValidator();
    const rules = { ...rule, allowed_values: { field: 'items', values: ['news'] } };

    const verdict = await v.check(step(rules), { items: ['news', 'invented'], confidence: 0.1 });

    // If the operator chose `send`, what goes out must be the filtered answer.
    expect(!verdict.ok && 'answer' in verdict && verdict.answer).toEqual({ items: ['news'], confidence: 0.1 });
  });
});

describe('an answer the rule cannot be applied to', () => {
  it('refuses a list of records rather than emptying it', async () => {
    // `{ type: array }` says nothing about what is inside, so this cannot be settled
    // until a value turns up. Comparing a record against a list of names can only say
    // "not in the list" — every item would be dropped and the run would report success
    // while publishing an empty list, every time, forever.
    const v = new RuleAnswerValidator();

    const verdict = await v.check(step({ allowed_values: { field: 'items', values: ['news'] } }), {
      items: [{ label: 'news' }],
    });

    expect(verdict).toEqual({ ok: false, reasons: [expect.stringContaining('allowed_values can compare')] });
  });

  it('still accepts names, and a single name', async () => {
    const v = new RuleAnswerValidator();
    const rule = step({ allowed_values: { field: 'items', values: ['news', '7'] } });

    expect(await v.check(rule, { items: ['news'] })).toMatchObject({ ok: true });
    expect(await v.check(rule, { items: 7 })).toMatchObject({ ok: true });
    expect(await v.check(rule, { items: null })).toMatchObject({ ok: true });
  });
});

describe('a pipeline with no rules', () => {
  it('passes the answer straight through', async () => {
    const v = new RuleAnswerValidator();

    expect(await v.check(step({}), { items: ['anything'] })).toEqual({
      ok: true,
      answer: { items: ['anything'] },
      dropped: undefined,
    });
  });
});
