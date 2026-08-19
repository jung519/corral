/**
 * The lifecycle's job is to spend a model turn only when it should, and to say precisely
 * where a run stopped when it didn't finish. Both are checked here without any real
 * HTTP, queue or model — the steps are stubs, which is the point of the ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, type CorralEvent } from '../../core/events.js';
import type {
  AnswerValidator,
  ContextResolver,
  InputResolver,
  OperationRunner,
  OutputSink,
  ValidationVerdict,
} from './ports.js';
import type { TokenUsage } from '../../core/token-budget.js';
import {
  PipelineRunner,
  conditionHolds,
  fillTemplate,
  fillValue,
  placeholderNames,
  readPath,
  type RunBudget,
  type RunDeps,
} from './run.js';
import { PipelineSchema, type Pipeline } from './schema.js';

function pipeline(overrides: Record<string, unknown> = {}): Pipeline {
  return PipelineSchema.parse({
    key: 'classify',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: {
      prompt: { system: 's', user_template: 'u' },
      schema: { type: 'object', properties: { items: { type: 'array' } } },
    },
    output: { kind: 'none' },
    ...overrides,
  });
}

/** Counts what each step was asked to do — the model call is the one that costs money. */
let calls: { resolve: number; context: number; operation: number; send: number };
let resolved: { raw: unknown; fields: Record<string, unknown> };
let verdict: ValidationVerdict;
let operationError: Error | undefined;
let resolveError: Error | undefined;
let sendError: Error | undefined;

const resolver: InputResolver = {
  kind: 'none',
  resolve: async () => {
    calls.resolve++;
    if (resolveError) throw resolveError;
    return resolved;
  },
};
const operation: OperationRunner = {
  run: async () => {
    calls.operation++;
    if (operationError) throw operationError;
    return { ok: true, answer: { items: ['a'] }, tokens: 120 };
  },
};
const validator: AnswerValidator = { check: async () => verdict };
const sink: OutputSink = {
  kind: 'none',
  send: async () => {
    calls.send++;
    if (sendError) throw sendError;
  },
};

/** What a `context` block resolves to, and whether asking for it fails. */
let contextFields: Record<string, unknown>;
let contextError: Error | undefined;
const context: ContextResolver = {
  resolve: async () => {
    calls.context++;
    if (contextError) throw contextError;
    return contextFields;
  },
};

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    resolvers: new Map([['none', resolver]]),
    context,
    operation,
    validator,
    sinks: new Map([['none', sink]]),
    ...over,
  };
}

/** A step that declares one list for its prompt. */
const withContext = { agent: { prompt: { system: 's', user_template: 'choose from {{allowed}}' }, schema: { type: 'object', properties: { items: { type: 'array' } } }, context: { allowed: { values: ['a', 'b'] } } } };

beforeEach(() => {
  calls = { resolve: 0, context: 0, operation: 0, send: 0 };
  resolved = { raw: { data: { labels: [] } }, fields: { title: 'a record' } };
  verdict = { ok: true, answer: { items: ['a'] } };
  contextFields = { allowed: ['a', 'b'] };
  operationError = resolveError = sendError = contextError = undefined;
});

describe('a run that works', () => {
  it('goes input → model → check → output and says so', async () => {
    const record = await new PipelineRunner(deps()).run(pipeline(), {});

    expect(record.outcome).toBe('completed');
    expect(record.stage).toBeUndefined();
    expect(record.tokens).toBe(120);
    expect(calls).toEqual({ resolve: 1, context: 0, operation: 1, send: 1 });
  });

  it('hands the output what the input selected AND what the model answered', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture: OutputSink = { kind: 'none', send: async (_o, fields) => void seen.push(fields) };

    await new PipelineRunner(deps({ sinks: new Map([['none', capture]]) })).run(pipeline(), {});

    // Output templates reference both — `{{id}}` from the source, `{{items}}` from the answer.
    expect(seen[0]).toEqual({ title: 'a record', items: ['a'] });
  });
});

describe('not spending a turn', () => {
  it('skips without calling the model when skip_if matches', async () => {
    // The duplicate-processing defence: a queue redelivering an already-handled event
    // must cost a fetch, never a second turn.
    resolved = { raw: { data: { labels: ['already', 'done'] } }, fields: { title: 'a record' } };
    const p = pipeline({ input: { kind: 'none', skip_if: { field: 'data.labels', is: 'non_empty' } } });

    const record = await new PipelineRunner(deps()).run(p, {});

    expect(record.outcome).toBe('skipped');
    expect(record.stage).toBe('input');
    expect(calls.operation).toBe(0);
  });

  it('runs normally when the same pipeline sees an unhandled event', async () => {
    const p = pipeline({ input: { kind: 'none', skip_if: { field: 'data.labels', is: 'non_empty' } } });

    expect((await new PipelineRunner(deps()).run(p, {})).outcome).toBe('completed');
    expect(calls.operation).toBe(1);
  });

  it('skips — not fails — when a required field is missing', async () => {
    // Retrying would fetch the same gap, so a failure here would retry forever.
    resolved = { raw: {}, fields: { title: '   ' } };
    const p = pipeline({ input: { kind: 'none', require: ['title'] } });

    const record = await new PipelineRunner(deps()).run(p, {});

    expect(record.outcome).toBe('skipped');
    expect(record.reason).toMatch(/missing required field\(s\): title/);
    expect(calls.operation).toBe(0);
  });

  it('does not call the model when the input step itself fails', async () => {
    resolveError = new Error('backend 503');

    const record = await new PipelineRunner(deps()).run(pipeline(), {});

    expect(record).toMatchObject({ outcome: 'input_failed', stage: 'input', reason: 'backend 503' });
    expect(calls.operation).toBe(0);
  });
});

describe('each failure is a different failure', () => {
  it('separates input, model, validation and output', async () => {
    const outcomes: Array<[string, string]> = [];

    resolveError = new Error('x');
    outcomes.push(['input', (await new PipelineRunner(deps()).run(pipeline(), {})).outcome]);

    resolveError = undefined;
    operationError = new Error('rate limited');
    outcomes.push(['agent', (await new PipelineRunner(deps()).run(pipeline(), {})).outcome]);

    operationError = undefined;
    verdict = { ok: false, reasons: ['items had 9 entries, limit is 4'] };
    outcomes.push(['validate', (await new PipelineRunner(deps()).run(pipeline(), {})).outcome]);

    verdict = { ok: true, answer: { items: ['a'] } };
    sendError = new Error('PATCH 401');
    outcomes.push(['output', (await new PipelineRunner(deps()).run(pipeline(), {})).outcome]);

    // Four problems, four fixes — an operator reading history has to be able to tell them
    // apart at a glance.
    expect(outcomes).toEqual([
      ['input', 'input_failed'],
      ['agent', 'agent_failed'],
      ['validate', 'rejected'],
      ['output', 'output_failed'],
    ]);
  });

  it('keeps the token cost on a run that died after the turn', async () => {
    sendError = new Error('PATCH 401');

    const record = await new PipelineRunner(deps()).run(pipeline(), {});

    // The expensive failure. Losing the token count here would understate what the
    // pipeline actually spent.
    expect(record).toMatchObject({ outcome: 'output_failed', stage: 'output', tokens: 120 });
  });
});

/**
 * A turn the model failed is still a turn the model was paid for. Before CRL-44 the failure
 * path returned above `budget.record`, so a pipeline whose answers never matched its schema
 * billed all day against a ceiling that read zero — the spend control bypassed by the shape
 * of the code rather than by any decision.
 */
describe('material the prompt needs', () => {
  it('reaches the model alongside the input', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture: OperationRunner = {
      run: async (_s, fields) => {
        seen.push(fields);
        return { ok: true, answer: { items: ['a'] } };
      },
    };

    await new PipelineRunner(deps({ operation: capture })).run(pipeline(withContext), {});

    expect(seen[0]).toEqual({ allowed: ['a', 'b'], title: 'a record' });
  });

  it('is not fetched by a pipeline that declares none', async () => {
    await new PipelineRunner(deps()).run(pipeline(), {});

    expect(calls.context).toBe(0);
  });

  it('loses a name to the event and to the input', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture: OperationRunner = {
      run: async (_s, fields) => {
        seen.push(fields);
        return { ok: true, answer: { items: ['a'] } };
      },
    };
    contextFields = { allowed: ['a'], title: 'the list won' };

    await new PipelineRunner(deps({ operation: capture })).run(pipeline(withContext), {});

    // The value belonging to this run is the more specific one — the same order a `select`
    // already beats the event by.
    expect(seen[0]).toMatchObject({ title: 'a record' });
  });

  it('reaches the output template too, so {{allowed}} means the same thing everywhere', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capture: OutputSink = { kind: 'none', send: async (_o, fields) => void seen.push(fields) };

    await new PipelineRunner(deps({ sinks: new Map([['none', capture]]) })).run(pipeline(withContext), {});

    expect(seen[0]).toMatchObject({ allowed: ['a', 'b'] });
  });

  it('is fetched after the ceiling check, so a spent day costs no requests', async () => {
    const budget: RunBudget = { check: () => ({ ok: false, reason: 'spent' }), record: () => {} };

    const record = await new PipelineRunner(deps({ budget })).run(pipeline(withContext), {});

    expect(record.outcome).toBe('over_budget');
    expect(calls.context).toBe(0);
  });
});

describe('material that cannot be had', () => {
  it('stops the run before the model is asked', async () => {
    contextError = new Error('vocabulary endpoint said 500');

    const record = await new PipelineRunner(deps()).run(pipeline(withContext), {});

    // A prompt saying "choose from nothing" would spend a turn the answer check then throws
    // away. Nothing is spent here.
    expect(calls.operation).toBe(0);
    expect(record.tokens).toBeUndefined();
  });

  it('says which step it was and why', async () => {
    contextError = new Error('vocabulary endpoint said 500');

    const record = await new PipelineRunner(deps()).run(pipeline(withContext), {});

    expect(record).toMatchObject({ outcome: 'input_failed', stage: 'context' });
    expect(record.reason).toContain('500');
  });

  it('is refused when nothing is wired to fetch it at all', async () => {
    const record = await new PipelineRunner(deps({ context: undefined })).run(pipeline(withContext), {});

    // Silently ignoring the block would send the prompt out with an empty placeholder,
    // which is the failure this whole feature exists to stop.
    expect(record).toMatchObject({ outcome: 'input_failed', stage: 'context' });
    expect(calls.operation).toBe(0);
  });
});

describe('what a failed turn costs', () => {
  /** A runner that reports a failure the way the port asks it to: with the bill attached. */
  const failsExpensively: OperationRunner = {
    run: async () => ({ ok: false, reason: 'no provider produced a usable answer', inputTokens: 4000, outputTokens: 120, tokens: 4120 }),
  };

  function counting(): { budget: RunBudget; spent: TokenUsage[] } {
    const spent: TokenUsage[] = [];
    return { budget: { check: () => ({ ok: true }), record: (u) => spent.push(u) }, spent };
  }

  it('charges the ceiling for a turn that ended in agent_failed', async () => {
    const { budget, spent } = counting();

    const record = await new PipelineRunner(deps({ operation: failsExpensively, budget })).run(pipeline(), {});

    expect(record.outcome).toBe('agent_failed');
    expect(spent).toEqual([{ inputTokens: 4000, outputTokens: 120 }]);
  });

  it('puts the cost in the history too, so an operator can see what was burned', async () => {
    const record = await new PipelineRunner(deps({ operation: failsExpensively })).run(pipeline(), {});

    expect(record).toMatchObject({ outcome: 'agent_failed', stage: 'agent', tokens: 4120, inputTokens: 4000 });
  });

  it('stops the next run once repeated failures reach the ceiling', async () => {
    // The point of counting them: a pipeline that only ever fails must still be able to
    // exhaust the day's budget, or it becomes an uncapped bill.
    let total = 0;
    const budget: RunBudget = {
      check: () => (total >= 4000 ? { ok: false, reason: 'daily input tokens spent' } : { ok: true }),
      record: (u) => void (total += u.inputTokens),
    };
    const runner = new PipelineRunner(deps({ operation: failsExpensively, budget }));

    expect((await runner.run(pipeline(), {})).outcome).toBe('agent_failed');
    expect((await runner.run(pipeline(), {})).outcome).toBe('over_budget');
  });

  it('records nothing when the runner itself broke', async () => {
    // An exception is a bug in the runner, not a failed turn. Nobody knows what it spent,
    // and zero is the honest answer to a question nobody can answer.
    const { budget, spent } = counting();
    operationError = new Error('rate limited');

    const record = await new PipelineRunner(deps({ budget })).run(pipeline(), {});

    expect(record.outcome).toBe('agent_failed');
    expect(spent).toEqual([]);
  });

  it('names the missing adapter rather than failing vaguely', async () => {
    const record = await new PipelineRunner(deps({ sinks: new Map() })).run(pipeline(), {});

    expect(record).toMatchObject({ outcome: 'output_failed', reason: 'no sink for output kind "none"' });
  });
});

describe('an answer the model is not sure about', () => {
  beforeEach(() => {
    verdict = { ok: false, lowConfidence: true, reasons: ['confidence 0.4 < 0.7'], answer: { items: ['a'] } };
  });

  it('is held back with a link, and nothing is written', async () => {
    const p = pipeline({
      on_low_confidence: { action: 'report', review_url: 'https://example.test/admin/{{title}}' },
    });

    const record = await new PipelineRunner(deps()).run(p, {});

    expect(record.outcome).toBe('reported');
    expect(record.reviewUrl).toBe('https://example.test/admin/a record');
    expect(calls.send).toBe(0); // a doubtful answer in someone's system is worse than none
  });

  it('is sent anyway when the operator asked for that', async () => {
    const p = pipeline({ on_low_confidence: { action: 'send' } });

    expect((await new PipelineRunner(deps()).run(p, {})).outcome).toBe('completed');
    expect(calls.send).toBe(1);
  });

  it('is dropped when the operator asked for that', async () => {
    const p = pipeline({ on_low_confidence: { action: 'skip' } });

    expect((await new PipelineRunner(deps()).run(p, {})).outcome).toBe('skipped');
    expect(calls.send).toBe(0);
  });
});

describe('concurrency', () => {
  it('never exceeds the pipeline limit, however the runs arrive', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: OperationRunner = {
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { ok: true, answer: { items: ['a'] } };
      },
    };
    const runner = new PipelineRunner(deps({ operation: slow }));
    const p = pipeline({ max_concurrent: 2 });

    const records = await Promise.all(Array.from({ length: 6 }, () => runner.run(p, {})));

    expect(peak).toBeLessThanOrEqual(2);
    expect(records.filter((r) => r.outcome === 'throttled').length).toBe(4);
    expect(runner.activeCount('classify')).toBe(0); // slots are given back
  });

  it('gives the slot back even when the run blows up', async () => {
    operationError = new Error('boom');
    const runner = new PipelineRunner(deps());

    await runner.run(pipeline({ max_concurrent: 1 }), {});

    expect(runner.activeCount('classify')).toBe(0);
    expect((await runner.run(pipeline({ max_concurrent: 1 }), {})).outcome).not.toBe('throttled');
  });

  it('refuses rather than queueing — the trigger decides what to do about it', async () => {
    const held = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const slow: OperationRunner = { run: async () => (await held, { ok: true, answer: {} }) };
    const runner = new PipelineRunner(deps({ operation: slow }));
    const p = pipeline({ max_concurrent: 1 });

    const [, second] = await Promise.all([runner.run(p, {}), runner.run(p, {})]);

    // A backlog held here would be lost on restart; the queue already knows how to
    // redeliver an unacknowledged message.
    expect(second).toMatchObject({ outcome: 'throttled', reason: expect.stringContaining('1/1') });
  });
});

describe('what the run tells the outside world', () => {
  let seen: CorralEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    seen = [];
    unsubscribe = bus.subscribe((e) => seen.push(e));
  });
  afterEach(() => unsubscribe());

  it('emits start and end against the run, not against an issue', async () => {
    const record = await new PipelineRunner(deps()).run(pipeline(), {});

    const runEvents = seen.filter((e) => e.kind === 'run');
    expect(runEvents.map((e) => e.label)).toEqual(['run started', 'run completed']);
    // The identifier is the run; the pipeline it belongs to rides along in data.
    expect(runEvents[0]!.identifier).toBe(record.id);
    expect(runEvents[0]!.data).toMatchObject({ pipeline: 'classify' });
  });

  it('reports the outcome and the failing stage on the end event', async () => {
    operationError = new Error('rate limited');

    await new PipelineRunner(deps()).run(pipeline(), {});

    expect(seen.at(-1)).toMatchObject({
      kind: 'run',
      data: { outcome: 'agent_failed', stage: 'agent', reason: 'rate limited' },
    });
  });

  it('gives every run its own id', async () => {
    const runner = new PipelineRunner(deps());

    const ids = [await runner.run(pipeline(), {}), await runner.run(pipeline(), {})].map((r) => r.id);

    expect(new Set(ids).size).toBe(2);
  });
});

describe('the names a template asks for', () => {
  it('finds them wherever they sit in a request', () => {
    // A request block is the shape this exists for: the URL, a header and a body are all
    // places an event's field can be needed from.
    const request = {
      method: 'GET',
      url: 'https://api.example.com/records/{{id}}',
      headers: { 'x-tenant': '{{tenant}}' },
      body: { nested: ['{{deep}}'] },
    };
    expect(placeholderNames(request)).toEqual(['id', 'tenant', 'deep']);
  });

  it('says nothing when nothing is asked for', () => {
    // A fixed URL needs no event, which is what lets a manual run just go (CRL-72).
    expect(placeholderNames({ url: 'https://api.example.com/records' })).toEqual([]);
  });

  it('names each one once', () => {
    expect(placeholderNames({ a: '{{id}}/{{id}}', b: '{{ id }}' })).toEqual(['id']);
  });

  it('reads the same names fillTemplate would fill', () => {
    // The two have to agree about what a placeholder is, or a prefilled body would offer
    // a name the substitution ignores.
    const template = 'a {{one}} b {{two.deep}} c {{not-a-name}}';
    expect(placeholderNames(template)).toEqual(['one', 'two.deep']);
    expect(fillTemplate(template, { one: 1, 'two.deep': 2 })).toBe('a 1 b 2 c {{not-a-name}}');
  });
});

describe('reaching into a list', () => {
  // A controlled vocabulary is very often a parent/child tree. This shape is the one that
  // made the feature necessary — a real endpoint that answers with its minors nested
  // (CRL-70).
  const tags = {
    majors: [
      { key: 'FOOD', minors: [{ key: 'BUNSIK' }, { key: 'FRUIT' }] },
      { key: 'ACTIVITY', minors: [{ key: 'CRAFT' }] },
    ],
  };

  it('crosses one list', () => {
    expect(readPath(tags, 'majors[].key')).toEqual(['FOOD', 'ACTIVITY']);
  });

  it('crosses two, and flattens', () => {
    // Not [["BUNSIK","FRUIT"],["CRAFT"]]. A list of allowed values is one list.
    expect(readPath(tags, 'majors[].minors[].key')).toEqual(['BUNSIK', 'FRUIT', 'CRAFT']);
  });

  it('leaves a path without `[]` alone', () => {
    expect(readPath(tags, 'majors.minors')).toBeUndefined();
    expect(readPath(tags, 'majors.0.minors.0.key')).toBe('BUNSIK');
  });

  it('drops items that do not have the field', () => {
    // A hole would survive as `undefined`, and `allowed_values` renders what it is given
    // with String() — which would admit the literal "undefined" as an allowed value.
    expect(readPath({ a: [{ k: 1 }, {}, { k: 3 }] }, 'a[].k')).toEqual([1, 3]);
  });

  it('answers undefined when the thing is not a list', () => {
    // `[]` on a string is a path that does not match what is there, which is the same
    // answer a missing key gets rather than a special kind of failure.
    expect(readPath(tags, 'majors[].key[]')).toBeUndefined();
    expect(readPath(tags, 'nope[].x')).toBeUndefined();
  });

  it('answers an empty list when no item has the field', () => {
    // Different from undefined on purpose: the lists were there and were crossed, and
    // nothing in them answered to that name.
    expect(readPath(tags, 'majors[].nope')).toEqual([]);
  });
});

describe('the small pieces', () => {
  it('reads dotted paths, and missing ones are just missing', () => {
    expect(readPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(readPath({ a: null }, 'a.b.c')).toBeUndefined();
    expect(readPath(undefined, 'a')).toBeUndefined();
  });

  it('treats blank strings, empty arrays and empty objects as empty', () => {
    const empty = { field: 'v', is: 'empty' } as const;
    for (const value of ['', '  ', [], {}, null, undefined]) {
      expect(conditionHolds(empty, { v: value })).toBe(true);
    }
    for (const value of ['x', [1], { a: 1 }, 0, false]) {
      expect(conditionHolds(empty, { v: value })).toBe(false);
    }
  });

  it('fills templates and leaves no placeholder behind for an unknown name', () => {
    expect(fillTemplate('a/{{id}}/b', { id: 7 })).toBe('a/7/b');
    expect(fillTemplate('a/{{ id }}/b', { id: 7 })).toBe('a/7/b');
    expect(fillTemplate('a/{{nope}}/b', {})).toBe('a//b');
  });

  it('writes a list into text as JSON, not as [object Object]', () => {
    // This text is a prompt. `String(value)` would put the field name in front of the
    // model and none of the data behind it.
    expect(fillTemplate('items:\n{{items}}', { items: [{ id: 1 }, { id: 2 }] })).toBe('items:\n[{"id":1},{"id":2}]');
  });

  it('keeps the value itself when the template is nothing but the placeholder', () => {
    // A body template is the receiver's JSON. `["a","b"]` must not arrive as `"a,b"`.
    expect(fillValue('{{items}}', { items: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(fillValue('{{n}}', { n: 0.91 })).toBe(0.91);
    expect(fillValue('{{ok}}', { ok: false })).toBe(false);
    expect(fillValue('{{rec}}', { rec: { a: 1 } })).toEqual({ a: 1 });
  });

  it('is text again as soon as anything surrounds the placeholder', () => {
    expect(fillValue('id-{{n}}', { n: 7 })).toBe('id-7');
    expect(fillValue('{{a}}/{{b}}', { a: 1, b: 2 })).toBe('1/2');
  });

  it('sends null for a field that is not there, rather than an empty string', () => {
    // "" is a value. A receiver cannot tell it from one the model produced.
    expect(fillValue('{{nope}}', {})).toBeNull();
  });
});
