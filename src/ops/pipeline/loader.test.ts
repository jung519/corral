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

    const [p] = await loadPipelines(dir);

    expect(p.key).toBe('classify-record');
    expect(p.max_concurrent).toBe(2);
    expect(p.trigger).toMatchObject({ kind: 'pubsub', topic: 'records.created', subscription: 'corral-classify' });
    expect(p.input.kind).toBe('http');
    expect(p.input.select.detail).toEqual({ path: 'data.description', truncate: 700 });
    expect(p.input.skip_if).toEqual({ field: 'data.labels', is: 'non_empty' });
    expect(p.agent.prompt.user_template).toContain('{{title}}');
    expect(p.agent.validate.min_confidence).toEqual({ field: 'confidence', threshold: 0.7 });
    expect(p.output).toMatchObject({ kind: 'http', request: { method: 'PATCH' } });
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

    const [p] = await loadPipelines(dir);

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
  schema: { type: object, properties: {} }
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
  schema: { type: object, properties: {} }
output: { kind: none }
`);

    expect(err.issues[0]).toMatchObject({ path: 'max_concurrent' });
    expect(err.issues[0].message).toMatch(/number/i);
  });

  it('rejects an adapter kind nothing implements, and lists the ones that exist', async () => {
    const err = await load(`
key: unknown-kind
trigger: { kind: carrier-pigeon }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: {} }
output: { kind: none }
`);

    // A kind in the schema that nothing runs would mean accepting a pipeline that can
    // never fire — the message has to point at what is actually available.
    expect(err.issues[0].path).toContain('trigger');
    expect(err.issues[0].message).toMatch(/manual|schedule|pubsub/);
  });

  it('rejects a key that would not survive being used as an identifier', async () => {
    const err = await load(`
key: "Classify Records!"
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: {} }
output: { kind: none }
`);

    expect(err.issues[0]).toMatchObject({ path: 'key' });
    expect(err.issues[0].message).toMatch(/lowercase/);
  });

  it('rejects an allowed-values rule with no list and nowhere to get one', async () => {
    const err = await load(`
key: no-vocabulary
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: {} }
  validate:
    allowed_values: { field: items }
output: { kind: none }
`);

    expect(err.issues[0].message).toMatch(/inline `values` list or a `source`/);
  });

  it('reports malformed YAML against the file rather than crashing the load', async () => {
    const err = await load('key: [unclosed\n');

    expect(err.issues[0]).toMatchObject({ file: 'broken.yaml', path: '' });
    expect(err.issues[0].message).toMatch(/not valid YAML/);
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
  schema: { type: object, properties: {} }
output: { kind: none }
`);

    expect(new Set(err.issues.map((i) => i.file))).toEqual(new Set(['a.yaml', 'b.yaml']));
  });
});

describe('two pipelines under one key', () => {
  it('is refused — history and manual runs would be ambiguous', async () => {
    const body = `
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: {} }
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
    // The operational AI is generic infrastructure. A field called `festival` or `ticket`
    // here would make every other user's pipeline read like someone else's product.
    const names = fieldNames(PipelineSchema);

    expect(names.has('key')).toBe(true); // the walker actually found the fields
    expect(names.size).toBeGreaterThan(20);
    for (const word of ['festival', 'tag', 'category', 'record', 'issue', 'ticket', 'product', 'article']) {
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
