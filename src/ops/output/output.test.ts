/**
 * Delivering the result — and, just as much, NOT delivering one that failed its checks.
 *
 * Both sinks run against real servers here, and the "not delivered" cases go through the
 * whole lifecycle, because that is where the decision actually lives.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../../credentials/file-store.js';
import { startOpsHost } from '../ops-host.js';
import type { OperationRunner } from '../pipeline/ports.js';
import { PipelineSchema, type Pipeline } from '../pipeline/schema.js';
import { HttpOutputSink } from './http.js';
import { PubSubOutputSink } from './pubsub.js';

let server: Server;
let base: string;
let dir: string;
let requests: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }>;
let status = 200;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'corral-output-'));
  requests = [];
  status = 200;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageIds: ['1'] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env.PUBSUB_EMULATOR_HOST;
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const output = (o: Record<string, unknown>): Pipeline['output'] =>
  PipelineSchema.parse({
    key: 'p',
    trigger: { kind: 'manual' },
    input: { kind: 'none' },
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    output: o,
  }).output;

describe('calling the user API', () => {
  it('sends the request the definition describes', async () => {
    const sink = new HttpOutputSink();

    await sink.send(
      output({
        kind: 'http',
        request: { method: 'PATCH', url: `${base}/api/records/{{id}}`, body: { labels: '{{items}}' } },
      }),
      { id: 42, items: 'news' },
    );

    expect(requests[0]).toMatchObject({ method: 'PATCH', url: '/api/records/42' });
    expect(JSON.parse(requests[0].body)).toEqual({ labels: 'news' });
  });

  it('can reference the identifier it came in with as well as the answer', async () => {
    const sink = new HttpOutputSink();

    // `fields` is the input's selection merged with the model's answer, which is what
    // makes "PATCH back to the record you just read" the obvious definition.
    await sink.send(
      output({ kind: 'http', request: { method: 'POST', url: `${base}/r`, body: { id: '{{id}}', title: '{{title}}' } } }),
      { id: 7, title: 'a record', items: [] },
    );

    // 7 stays a number: the body template is the receiver's JSON, not a rendering of it.
    expect(JSON.parse(requests[0].body)).toEqual({ id: 7, title: 'a record' });
  });

  it('attaches the credential the definition names', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'backend', account: 'default' }, 'super-secret');

    await new HttpOutputSink(credentials).send(
      output({ kind: 'http', request: { method: 'POST', url: `${base}/r`, credential: { service: 'backend', account: 'default' } } }),
      {},
    );

    expect(requests[0].headers.authorization).toBe('Bearer super-secret');
  });

  it('raises a rejected write rather than swallowing it', async () => {
    status = 401;

    await expect(new HttpOutputSink().send(output({ kind: 'http', request: { url: `${base}/r` } }), {})).rejects.toThrow(
      /401/,
    );
  });
});

describe('publishing a message', () => {
  beforeEach(() => {
    process.env.PUBSUB_EMULATOR_HOST = base.replace('http://', '');
  });

  it('publishes the whole result when no template is given', async () => {
    await new PubSubOutputSink().send(output({ kind: 'pubsub', topic: 'projects/p/topics/results' }), {
      id: 42,
      items: ['news'],
    });

    expect(requests[0].url).toBe('/v1/projects/p/topics/results:publish');
    const sent = JSON.parse(requests[0].body) as { messages: Array<{ data: string }> };
    expect(JSON.parse(Buffer.from(sent.messages[0].data, 'base64').toString())).toEqual({ id: 42, items: ['news'] });
  });

  it('fills a message template when one is', async () => {
    await new PubSubOutputSink().send(
      output({ kind: 'pubsub', topic: 'projects/p/topics/results', message: { recordId: '{{id}}', labels: '{{items}}' } }),
      { id: 42, items: 'news' },
    );

    const sent = JSON.parse(requests[0].body) as { messages: Array<{ data: string }> };
    expect(JSON.parse(Buffer.from(sent.messages[0].data, 'base64').toString())).toEqual({
      recordId: 42,
      labels: 'news',
    });
  });

  it('raises a refused publish', async () => {
    status = 403;

    await expect(
      new PubSubOutputSink().send(output({ kind: 'pubsub', topic: 'projects/p/topics/results' }), {}),
    ).rejects.toThrow(/403/);
  });
});

describe('what never gets sent', () => {
  function writePipeline(body: string): void {
    mkdirSync(join(dir, 'pipelines'), { recursive: true });
    writeFileSync(join(dir, 'pipelines', 'c.yaml'), body);
  }

  const definition = (validate: string, onLow = 'report'): string => `
key: classify
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema:
    type: object
    properties: { items: { type: array }, confidence: { type: number } }
  validate:${validate}
output:
  kind: http
  request: { method: PATCH, url: "${base}/api/records/1", body: { labels: "{{items}}" } }
on_low_confidence: { action: ${onLow}, review_url: "https://example.test/review" }
`;

  const answers = (answer: Record<string, unknown>): OperationRunner => ({
    run: async () => ({ ok: true, answer, tokens: 10 }),
  });

  it('holds back a doubtful answer and records where to look', async () => {
    writePipeline(definition('\n    min_confidence: { field: confidence, threshold: 0.7 }'));
    const host = await startOpsHost({ stateDir: dir, operation: answers({ items: ['news'], confidence: 0.3 }) });

    const { run } = await host.runManually('classify', {});

    // A doubtful answer written into someone's system is worse than no answer.
    expect(run).toMatchObject({ outcome: 'reported', reviewUrl: 'https://example.test/review' });
    expect(requests).toHaveLength(0);
    expect((await host.history.list({ days: 1 }))[0]).toMatchObject({ outcome: 'reported', lowConfidence: true });
  });

  it('sends nothing when the answer broke a rule outright', async () => {
    writePipeline(definition('\n    allowed_values: { field: items, values: [news] }\n    min_confidence: { field: confidence, threshold: 0.1 }'));
    const host = await startOpsHost({ stateDir: dir, operation: answers({ items: ['news'], confidence: 'not a number' }) });

    const { run } = await host.runManually('classify', {});

    expect(run?.outcome).toBe('rejected');
    expect(requests).toHaveLength(0);
  });

  it('sends the cleaned answer, not the raw one, when the operator chose to send anyway', async () => {
    writePipeline(
      definition('\n    allowed_values: { field: items, values: [news] }\n    min_confidence: { field: confidence, threshold: 0.7 }', 'send'),
    );
    const host = await startOpsHost({
      stateDir: dir,
      operation: answers({ items: ['news', 'invented'], confidence: 0.3 }),
    });

    const { run } = await host.runManually('classify', {});

    expect(run?.outcome).toBe('completed');
    expect(JSON.parse(requests[0].body)).toEqual({ labels: ['news'] }); // the dropped value never left
  });

  it('records a failed delivery as its own thing, with the tokens it already spent', async () => {
    status = 500;
    writePipeline(definition(' {}'));
    const host = await startOpsHost({ stateDir: dir, operation: answers({ items: ['news'], confidence: 1 }) });

    const { run } = await host.runManually('classify', {});

    // The expensive failure: the turn is already paid for. An operator reading history
    // has to be able to tell it from a run that never called the model.
    expect(run).toMatchObject({ outcome: 'output_failed', stage: 'output', tokens: 10 });
    expect((await host.history.list({ days: 1 }))[0]).toMatchObject({ outcome: 'output_failed', tokens: 10 });
  });

  it('delivers when everything passed', async () => {
    writePipeline(definition('\n    min_confidence: { field: confidence, threshold: 0.7 }'));
    const host = await startOpsHost({ stateDir: dir, operation: answers({ items: ['news'], confidence: 0.9 }) });

    expect((await host.runManually('classify', {})).run?.outcome).toBe('completed');
    // A list answer arrives as a list. Joining it into "news" would be a different value
    // than the one the model gave and the validator approved.
    expect(JSON.parse(requests[0].body)).toEqual({ labels: ['news'] });
  });
});
