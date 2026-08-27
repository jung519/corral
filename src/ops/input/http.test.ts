/**
 * Fetching the input at processing time, against a real HTTP server.
 *
 * Two things carry the weight here: that one request shape covers REST and GraphQL
 * alike, and that "the record is gone" is never mistaken for "the fetch failed".
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
import { HttpInputResolver, TargetMissingError } from './http.js';

let server: Server;
let base: string;
let dir: string;
/** Every request the server saw, so a test can assert what went on the wire. */
let requests: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }>;
/** What to answer with next. */
let respond: (path: string) => { status: number; body: unknown };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'corral-http-input-'));
  requests = [];
  respond = () => ({ status: 200, body: { data: { title: 'a record' } } });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = respond(req.url ?? '');
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const pipeline = (input: Record<string, unknown>): Pipeline =>
  PipelineSchema.parse({
    key: 'classify',
    trigger: { kind: 'manual' },
    input,
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    output: { kind: 'none' },
  });

describe('an identifier becoming a record', () => {
  it('fills the URL from the event and selects out of the response', async () => {
    const input = pipeline({
      kind: 'http',
      request: { url: `${base}/api/records/{{id}}` },
      select: { title: 'data.title' },
    }).input;

    const resolved = await new HttpInputResolver().resolve(input, { id: 42 });

    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/records/42' });
    expect(resolved.fields).toEqual({ title: 'a record' });
  });

  it('keeps the whole response as `raw`, which is what skip_if reads', async () => {
    respond = () => ({ status: 200, body: { data: { title: 'a record', labels: ['done'] } } });
    const input = pipeline({ kind: 'http', request: { url: `${base}/r/{{id}}` }, select: { title: 'data.title' } }).input;

    const resolved = await new HttpInputResolver().resolve(input, { id: 1 });

    expect(resolved.raw).toEqual({ data: { title: 'a record', labels: ['done'] } });
  });

  it('uses the response as-is when the definition selects nothing', async () => {
    respond = () => ({ status: 200, body: { title: 'flat already' } });
    const input = pipeline({ kind: 'http', request: { url: `${base}/r/1` } }).input;

    expect((await new HttpInputResolver().resolve(input, {})).fields).toEqual({ title: 'flat already' });
  });

  it('truncates a long field where the definition says to', async () => {
    respond = () => ({ status: 200, body: { data: { description: 'x'.repeat(5000) } } });
    const input = pipeline({
      kind: 'http',
      request: { url: `${base}/r/1` },
      select: { detail: { path: 'data.description', truncate: 700 } },
    }).input;

    // Long free text is the usual reason a prompt gets expensive.
    expect(String((await new HttpInputResolver().resolve(input, {})).fields.detail)).toHaveLength(700);
  });
});

describe('the same shape for GraphQL', () => {
  it('posts a query and reads the answer out of `data`', async () => {
    respond = () => ({ status: 200, body: { data: { record: { title: 'from graphql' } } } });
    const input = pipeline({
      kind: 'http',
      request: {
        method: 'POST',
        url: `${base}/graphql`,
        body: { query: 'query($id: ID!) { record(id: $id) { title } }', variables: { id: '{{id}}' } },
      },
      select: { title: 'data.record.title' },
    }).input;

    const resolved = await new HttpInputResolver().resolve(input, { id: 42 });

    // No GraphQL adapter — it is a POST with a JSON body, and that is all it ever was.
    expect(requests[0]!.method).toBe('POST');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      query: 'query($id: ID!) { record(id: $id) { title } }',
      variables: { id: 42 },   // a number stays a number — the API declared the type, not us
    });
    expect(resolved.fields).toEqual({ title: 'from graphql' });
  });
});

describe('secrets', () => {
  it('are named by the definition and resolved from the store', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'backend', account: 'default' }, 'super-secret');
    const input = pipeline({
      kind: 'http',
      request: { url: `${base}/r/1`, credential: { service: 'backend', account: 'default' } },
    }).input;

    await new HttpInputResolver(credentials).resolve(input, {});

    // The definition holds a pointer; the value only exists at call time.
    expect(requests[0]!.headers.authorization).toBe('Bearer super-secret');
  });

  it('goes on whatever header the API wants', async () => {
    // An internal API behind a VPC is as likely to want `X-API-Key` as a bearer token,
    // and that should not cost the pipeline its credential store.
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'backend', account: 'default' }, 'super-secret');
    const input = pipeline({
      kind: 'http',
      request: {
        url: `${base}/r/1`,
        credential: { service: 'backend', account: 'default' },
        auth: { header: 'X-API-Key', prefix: '' },
      },
    }).input;

    await new HttpInputResolver(credentials).resolve(input, {});

    expect(requests[0]!.headers['x-api-key']).toBe('super-secret');
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it('lets a header in the definition win, whatever case it was written in', async () => {
    // HTTP header names are case-insensitive but a plain object is not: `Authorization`
    // here and `authorization` from the credential would both survive and go out
    // comma-joined — an auth header holding two values, which no server reads as either.
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'backend', account: 'default' }, 'super-secret');
    const input = pipeline({
      kind: 'http',
      request: {
        url: `${base}/r/1`,
        credential: { service: 'backend', account: 'default' },
        headers: { Authorization: 'Bearer from-the-definition' },
      },
    }).input;

    await new HttpInputResolver(credentials).resolve(input, {});

    expect(requests[0]!.headers.authorization).toBe('Bearer from-the-definition');
  });
});

describe('gone is not broken', () => {
  it('calls a 404 a missing target', async () => {
    respond = () => ({ status: 404, body: { error: 'not found' } });
    const input = pipeline({ kind: 'http', request: { url: `${base}/r/{{id}}` } }).input;

    await expect(new HttpInputResolver().resolve(input, { id: 9 })).rejects.toBeInstanceOf(TargetMissingError);
  });

  it('treats 410 the same way', async () => {
    respond = () => ({ status: 410, body: {} });
    const input = pipeline({ kind: 'http', request: { url: `${base}/r/1` } }).input;

    await expect(new HttpInputResolver().resolve(input, {})).rejects.toBeInstanceOf(TargetMissingError);
  });

  it('leaves a server error as an ordinary failure', async () => {
    respond = () => ({ status: 503, body: {} });
    const input = pipeline({ kind: 'http', request: { url: `${base}/r/1` } }).input;

    // A 503 may well work in a minute; a 404 answers the same way forever.
    const err = await new HttpInputResolver().resolve(input, {}).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TargetMissingError);
  });
});

describe('through the lifecycle', () => {
  const neverCalled: OperationRunner = {
    run: async () => {
      throw new Error('the model must not be called');
    },
  };

  function writePipeline(body: string): void {
    mkdirSync(join(dir, 'pipelines'), { recursive: true });
    writeFileSync(join(dir, 'pipelines', 'c.yaml'), body);
  }

  const definition = (extra = ''): string => `
key: classify
trigger: { kind: manual }
input:
  kind: http
  request: { url: "${base}/api/records/{{id}}" }
  select: { title: "data.title" }
  require: [title]${extra}
agent: { prompt: { system: s, user_template: "{{title}}" }, schema: { type: object, properties: { a: { type: string } } } }
output: { kind: none }
`;

  it('skips a record that is gone, rather than failing', async () => {
    respond = () => ({ status: 404, body: {} });
    writePipeline(definition());
    const host = await startOpsHost({ stateDir: dir, operation: neverCalled });

    const { run } = await host.runManually('classify', { id: 9 });

    // Skipped means the queue drops the message. Failed would mean redelivering a
    // deleted record until the dead-letter policy gave up.
    expect(run).toMatchObject({ outcome: 'skipped', stage: 'input' });
    expect(run?.reason).toMatch(/is gone/);
  });

  it('skips an event that did not carry what the url names, without fetching', async () => {
    writePipeline(definition());
    const host = await startOpsHost({ stateDir: dir, operation: neverCalled });

    const { run } = await host.runManually('classify', { wrongName: 9 });

    // Skipped for the same reason a gone record is: the redelivery carries the same event,
    // so the address is missing the same piece. What changed with CRL-74 is that it stops
    // before fetching — `/records/` is a different address, and what comes back from it is
    // somebody else's record or a list of them.
    expect(run).toMatchObject({ outcome: 'skipped', stage: 'input' });
    expect(run?.reason).toMatch(/"id"/);
    expect(requests).toEqual([]);
  });

  it('fails a fetch that could work next time', async () => {
    respond = () => ({ status: 503, body: {} });
    writePipeline(definition());
    const host = await startOpsHost({ stateDir: dir, operation: neverCalled });

    expect((await host.runManually('classify', { id: 9 })).run).toMatchObject({
      outcome: 'input_failed',
      stage: 'input',
    });
  });

  it('does not call the model when a required field came back empty', async () => {
    respond = () => ({ status: 200, body: { data: { title: '' } } });
    writePipeline(definition());
    const host = await startOpsHost({ stateDir: dir, operation: neverCalled });

    const { run } = await host.runManually('classify', { id: 1 });

    expect(run).toMatchObject({ outcome: 'skipped' });
    expect(run?.reason).toMatch(/missing required field\(s\): title/);
  });

  it('fetches, then skips on skip_if — without spending a turn', async () => {
    respond = () => ({ status: 200, body: { data: { title: 'a record', labels: ['done'] } } });
    writePipeline(definition('\n  skip_if: { field: "data.labels", is: non_empty }'));
    const host = await startOpsHost({ stateDir: dir, operation: neverCalled });

    const { run } = await host.runManually('classify', { id: 1 });

    // The fetch is cheap; the turn is not. That ordering is the whole point of fetch-back.
    expect(run?.outcome).toBe('skipped');
    expect(requests).toHaveLength(1);
  });
});
