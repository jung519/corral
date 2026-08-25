/**
 * A pipeline definition is the contract everything downstream is built on, so the
 * question here is narrow: does a good definition come back as usable runtime values,
 * and does a bad one get turned away with something the operator can act on?
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPipelines, PipelineLoadError, parsePipeline } from './loader.js';
import { PipelineSchema } from './schema.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-pipelines-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, yaml: string): void => writeFileSync(join(dir, name), yaml);

const VALID = `
key: classify-record
description: label incoming records
max_concurrent: 2

trigger:
  kind: pubsub
  topic: records.created
  subscription: corral-classify
  credential: { service: gcp, account: default }

input:
  kind: http
  request:
    method: GET
    url: "https://example.test/api/records/{{id}}"
    credential: { service: backend, account: default }
  select:
    title: "data.title"
    detail: { path: "data.description", truncate: 700 }
  require: [title]
  skip_if: { field: "data.labels", is: non_empty }

agent:
  max_tokens: 2048
  prompt:
    system: "You label records."
    user_template: |
      Title: {{title}}
      Detail: {{detail}}
  schema:
    type: object
    properties:
      items: { type: array }
      confidence: { type: number }
    required: [items, confidence]
  validate:
    allowed_values:
      field: items
      source:
        url: "https://example.test/api/vocabulary"
      select: "data.values"
    max_items: { field: items, limit: 4 }
    min_confidence: { field: confidence, threshold: 0.7 }

output:
  kind: http
  skip_if: { field: items, is: empty }
  request:
    method: PATCH
    url: "https://example.test/api/records/{{id}}"
    body: { labels: "{{items}}" }

on_low_confidence:
  action: report
  review_url: "https://example.test/admin/records/{{id}}"
`;

describe('a valid definition', () => {
  it('loads, and every field arrives as a runtime value', async () => {
    write('classify.yaml', VALID);

    const p = (await loadPipelines(dir))[0]!;

    expect(p.key).toBe('classify-record');
    expect(p.max_concurrent).toBe(2);
    expect(p.trigger).toMatchObject({ kind: 'pubsub', topic: 'records.created', subscription: 'corral-classify' });
    expect(p.input.kind).toBe('http');
    expect(p.input.select.detail).toEqual({ path: 'data.description', truncate: 700 });
    expect(p.input.skip_if).toEqual({ field: 'data.labels', is: 'non_empty' });
    expect(p.agent.prompt.user_template).toContain('{{title}}');
    expect(p.agent.validate.min_confidence).toEqual({ field: 'confidence', threshold: 0.7 });
    expect(p.output).toMatchObject({ kind: 'http', request: { method: 'PATCH' } });
    // A definition can say "nothing to write" without inventing a second vocabulary for it
    // — the same condition shape the input uses (CRL-92).
    expect(p.output).toMatchObject({ skip_if: { field: 'items', is: 'empty' } });
    expect(p.on_low_confidence.action).toBe('report');
  });

  it('fills in the defaults an operator should not have to write', async () => {
    write(
      'minimal.yaml',
      `
key: minimal
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`,
    );

    const p = (await loadPipelines(dir))[0]!;

    expect(p.enabled).toBe(true);
    expect(p.max_concurrent).toBe(1); // start at one and raise once measured
    expect(p.agent.max_tokens).toBe(4096);
    expect(p.on_low_confidence.action).toBe('report'); // don't write a doubtful answer
  });
});

describe('a broken definition is turned away at load', () => {
  const load = async (yaml: string): Promise<PipelineLoadError> => {
    write('broken.yaml', yaml);
    try {
      await loadPipelines(dir);
    } catch (err) {
      return err as PipelineLoadError;
    }
    throw new Error('expected the load to fail');
  };

  it('names the missing field', async () => {
    const err = await load(`
key: no-trigger
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(err.issues).toContainEqual(expect.objectContaining({ file: 'broken.yaml', path: 'trigger' }));
    expect(err.message).toContain('broken.yaml → trigger');
  });

  it('says what the wrong type was, not just that something is wrong', async () => {
    const err = await load(`
key: bad-type
max_concurrent: "lots"
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(err.issues[0]).toMatchObject({ path: 'max_concurrent' });
    expect(err.issues[0]!.message).toMatch(/number/i);
  });

  it('rejects an adapter kind nothing implements, and lists the ones that exist', async () => {
    const err = await load(`
key: unknown-kind
trigger: { kind: carrier-pigeon }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    // A kind in the schema that nothing runs would mean accepting a pipeline that can
    // never fire — the message has to point at what is actually available.
    expect(err.issues[0]!.path).toContain('trigger');
    expect(err.issues[0]!.message).toMatch(/manual|schedule|pubsub/);
  });

  it('rejects a key that would not survive being used as an identifier', async () => {
    const err = await load(`
key: "Classify Records!"
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(err.issues[0]).toMatchObject({ path: 'key' });
    expect(err.issues[0]!.message).toMatch(/lowercase/);
  });

  it('rejects a schema that declares no fields at all', async () => {
    const err = await load(`
key: declares-nothing
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: {} }
output: { kind: none }
`);

    // Only declared properties survive the answer check, so this pipeline would pay for a
    // turn and discard everything it got back — reporting success while doing nothing.
    expect(err.issues[0]!.message).toMatch(/at least one property/);
  });

  it('accepts what the editor builds for a list plus a rule that points at it', async () => {
    // The editor writes `source: { url }` with no method and `select` only when it was
    // filled in, and it writes `from` as the name it offered in a dropdown. If the defaults
    // did not cover that, the first save from a clean screen would fail on the editor's own
    // output (CRL-67).
    write('editor.yaml', `
key: from-the-editor
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: "choose from {{allowed}}" }
  schema: { type: object, properties: { items: { type: array } } }
  context:
    allowed:
      source: { url: "https://api.example.com/vocabulary" }
      select: data.values
  validate:
    allowed_values: { field: items, from: allowed }
output: { kind: none }
`);

    const pipelines = await loadPipelines(dir);

    expect(pipelines[0]!.agent.context.allowed).toMatchObject({ select: 'data.values' });
    expect(pipelines[0]!.agent.validate.allowed_values).toMatchObject({ from: 'allowed' });
  });

  it('rejects a `from` that names nothing in agent.context', async () => {
    const err = await load(`
key: no-such-context
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { items: { type: array } } }
  context:
    allowed: { values: [a, b] }
  validate:
    allowed_values: { field: items, from: allwoed }
output: { kind: none }
`);

    // The typo is the whole point — a rule pointing at a name nothing answers to would
    // never see a list, and the two blocks only meet at load time.
    expect(err.issues[0]!.path).toBe('agent.validate.allowed_values.from');
    expect(err.issues[0]!.message).toMatch(/not declared in `agent.context`.*"allowed"/);
  });

  it('rejects an allowed-values rule that names two sources for its list', async () => {
    const err = await load(`
key: two-sources
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { items: { type: array } } }
  context:
    allowed: { values: [a] }
  validate:
    allowed_values: { field: items, from: allowed, values: [b] }
output: { kind: none }
`);

    expect(err.issues[0]!.message).toMatch(/more than one source.*pick one/);
  });

  it('rejects an allowed-values rule with no list and nowhere to get one', async () => {
    const err = await load(`
key: no-vocabulary
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
  validate:
    allowed_values: { field: items }
output: { kind: none }
`);

    // Names all three ways, because a reader who wrote none of them has no way to guess
    // which one their case wants (CRL-66 added `from`).
    expect(err.issues[0]!.message).toMatch(/needs one of `values`.*`source`.*`from`/);
  });

  it('reports malformed YAML against the file rather than crashing the load', async () => {
    const err = await load('key: [unclosed\n');

    expect(err.issues[0]).toMatchObject({ file: 'broken.yaml', path: '' });
    expect(err.issues[0]!.message).toMatch(/not valid YAML/);
  });

  it('collects every problem in one pass instead of one per run', async () => {
    write('a.yaml', 'key: "BAD KEY"\ntrigger: { kind: manual }\n');
    write('b.yaml', '');

    const err = await load(`
key: ok-but-others-are-not
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(new Set(err.issues.map((i) => i.file))).toEqual(new Set(['a.yaml', 'b.yaml']));
  });

  /**
   * A rule that cannot do its job is the worst kind of broken, because nothing looks
   * broken: only declared properties survive the answer check, so a rule pointing anywhere
   * else examines a field that is never there. `allowed_values` and `max_items` then pass
   * everything and `min_confidence` rejects everything — the same mistake, three
   * behaviours, none of them the one that was meant.
   */
  const withRule = (properties: string, validate: string): string => `
key: mismatched
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: ${properties} }
  validate:${validate}
output: { kind: none }
`;

  it('refuses a rule that names a field the answer schema does not declare', async () => {
    const err = await load(withRule('{ items: { type: array } }', '\n    allowed_values: { field: labels, values: [a] }'));

    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: 'agent.validate.allowed_values.field', message: expect.stringContaining('not declared') }),
    );
  });

  it('refuses a rule the declared type cannot support', async () => {
    const err = await load(withRule('{ note: { type: string } }', '\n    max_items: { field: note, limit: 3 }'));

    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: 'agent.validate.max_items.field', message: expect.stringContaining('declared string') }),
    );
  });

  it('refuses allowed_values on a record', async () => {
    const err = await load(withRule('{ rec: { type: object } }', '\n    allowed_values: { field: rec, values: [a] }'));

    expect(err.issues).toContainEqual(expect.objectContaining({ path: 'agent.validate.allowed_values.field' }));
  });

  it('refuses a time zone this machine does not know', async () => {
    // A schedule that loads cleanly and then fires at the wrong hour forever is worse than
    // one that refuses to load.
    const err = await load(`
key: nightly
trigger: { kind: schedule, cron: "0 9 * * *", timezone: "Seoul" }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: 'trigger.timezone', message: expect.stringContaining('not a time zone') }),
    );
  });

  describe('a Pub/Sub pipeline that could never receive anything', () => {
    const EMULATOR = process.env.PUBSUB_EMULATOR_HOST;
    afterEach(() => {
      if (EMULATOR === undefined) delete process.env.PUBSUB_EMULATOR_HOST;
      else process.env.PUBSUB_EMULATOR_HOST = EMULATOR;
    });

    const queuePipeline = `
key: nightly
trigger: { kind: pubsub, topic: "records", subscription: "projects/p/subscriptions/s" }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`;

    it('loads with no credential — the machine it runs on may be somebody', async () => {
      // This used to be refused here (CRL-46: a pipeline that looked subscribed and
      // received nothing). It cannot be any more: a core on a GCE VM reaches Pub/Sub with
      // no credential at all, and whether a machine has an identity is not knowable from a
      // definition — least of all by a desktop saving one for a core somewhere else
      // (CRL-95).
      //
      // The protection moved rather than went away. `pubsubClient` throws with all three
      // ways named, and the trigger turns that into `blocked` carrying the sentence — see
      // google-pubsub.test.ts and pubsub.test.ts.
      delete process.env.PUBSUB_EMULATOR_HOST;
      write('queue.yaml', queuePipeline);

      await expect(loadPipelines(dir)).resolves.toHaveLength(1);
    });

    it('loads with no credential at all when the emulator is set', async () => {
      process.env.PUBSUB_EMULATOR_HOST = '127.0.0.1:8085';
      write('ok.yaml', queuePipeline);

      await expect(loadPipelines(dir)).resolves.toHaveLength(1);
    });
  });

  it('refuses a pubsub output that says nothing about what to publish', async () => {
    // While this was optional the sink published the whole bag it was handed — the event,
    // the fetched record and the answer together (CRL-51).
    const err = await load(`
key: nightly
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: pubsub, topic: "projects/p/topics/results" }
`);

    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: 'output.message', message: expect.stringContaining('needs a message') }),
    );
  });

  it('refuses a schedule nobody can execute, naming the field', async () => {
    // `-5` read as the range 0-5 and fired six times an hour on the hour, saying nothing
    // (CRL-48). Now that a box exists for typing an expression by hand, the mistake has to
    // come back while the person is still looking at it — same reasoning as the zone above.
    const err = await load(`
key: nightly
trigger: { kind: schedule, cron: "-5 * * * *" }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    expect(err.issues).toContainEqual(
      expect.objectContaining({ path: 'trigger.cron', message: expect.stringContaining('minute "-5"') }),
    );
  });

  it('takes an IANA zone', async () => {
    write('ok.yaml', `
key: nightly
trigger: { kind: schedule, cron: "0 9 * * *", timezone: "Asia/Seoul" }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`);

    await expect(loadPipelines(dir)).resolves.toHaveLength(1);
  });

  it('leaves an undeclared type to the validator, which sees the real value', async () => {
    // `{ type: array }` with no `items` is the common case and perfectly legitimate.
    write('ok.yaml', withRule('{ items: { type: array } }', '\n    allowed_values: { field: items, values: [a] }'));

    await expect(loadPipelines(dir)).resolves.toHaveLength(1);
  });
});

describe('two pipelines under one key', () => {
  it('is refused — history and manual runs would be ambiguous', async () => {
    const body = `
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`;
    write('first.yaml', `key: same${body}`);
    write('second.yaml', `key: same${body}`);

    await expect(loadPipelines(dir)).rejects.toThrow(/duplicate key "same" — already defined in first\.yaml/);
  });
});

describe('nothing configured', () => {
  it('is a normal state, not a failure', async () => {
    await expect(loadPipelines(join(dir, 'does-not-exist'))).resolves.toEqual([]);
    await expect(loadPipelines(dir)).resolves.toEqual([]);
  });

  it('ignores files that are not YAML', async () => {
    mkdirSync(join(dir, 'notes'));
    write('README.md', 'not a pipeline');

    await expect(loadPipelines(dir)).resolves.toEqual([]);
  });
});

describe('the schema stays domain-neutral', () => {
  /** Every field name a definition can contain, gathered from the schema itself — asking
   *  the schema rather than grepping the file, which would trip over `z.record`. */
  function fieldNames(schema: unknown, seen = new Set<string>()): Set<string> {
    const def = (schema as { _def?: Record<string, unknown> })?._def;
    if (!def) return seen;
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (shape) for (const [name, child] of Object.entries(shape)) (seen.add(name), fieldNames(child, seen));
    for (const key of ['innerType', 'schema', 'type', 'valueType'] as const) {
      if (def[key]) fieldNames(def[key], seen);
    }
    if (Array.isArray(def.options)) for (const o of def.options) fieldNames(o, seen);
    return seen;
  }

  it('names nothing that only makes sense for one kind of business', () => {
    // The operational AI is generic infrastructure. A field named after one kind of
    // business would make every other user's pipeline read like someone else's product.
    const names = fieldNames(PipelineSchema);

    expect(names.has('key')).toBe(true); // the walker actually found the fields
    expect(names.size).toBeGreaterThan(20);
    for (const word of ['invoice', 'tag', 'category', 'record', 'issue', 'ticket', 'product', 'article']) {
      expect([...names].filter((n) => n.includes(word))).toEqual([]);
    }
  });
});

describe('validating before writing', () => {
  it('hands back the problems without touching disk, for the editor UI', () => {
    const { pipeline, issues } = parsePipeline({ key: 'x', trigger: { kind: 'manual' } });

    expect(pipeline).toBeUndefined();
    expect(issues.map((i) => i.path)).toContain('input');
  });
});
