/**
 * The manual run is the only way in before any trigger exists — it's how a pipeline gets
 * tried out while it's being written, and how a failed one gets reprocessed. So it has to
 * work with nothing configured but a definition file, and it has to leave a trace.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOpsHost } from './ops-host.js';
import type { OperationRunner } from './pipeline/ports.js';

let dir: string;

const PIPELINE = `
key: echo
description: hand the body straight back
trigger: { kind: manual }
input:
  kind: none
  select:
    title: "data.title"
agent:
  prompt: { system: s, user_template: "{{title}}" }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`;

/** A model step that answers without a model. */
const stubModel: OperationRunner = {
  run: async (_step, fields) => ({
    ok: true,
    answer: { answer: `saw ${String(fields.title)}` },
    tokens: 42,
    provider: 'claude',
  }),
};

function writePipeline(name: string, body: string): void {
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(join(dir, 'pipelines', name), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-ops-host-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('running a pipeline by hand', () => {
  it('runs it with no trigger configured and returns the result', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const result = await host.runManually('echo', { data: { title: 'a record' } });

    expect(result.ok).toBe(true);
    expect(result.run).toMatchObject({ pipeline: 'echo', outcome: 'completed', tokens: 42, provider: 'claude' });
  });

  it('leaves the run in the history, whether it worked or not', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    await host.runManually('echo', { data: { title: 'first' } });
    await host.runManually('echo', {}); // no title — still a run, still recorded

    const runs = await host.history.list({ days: 1 });
    // A history with only the successes in it would be useless for what history is for.
    expect(runs).toHaveLength(2);
    expect((await host.history.totals(1))[0].runs).toBe(2);
  });

  it('says which pipeline it could not find', async () => {
    const host = await startOpsHost({ stateDir: dir });

    expect(await host.runManually('nope', {})).toEqual({ ok: false, error: 'no pipeline named "nope"' });
  });

  it('still runs a disabled pipeline', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });
    host.registry.setEnabled('echo', false);

    // Disabling stops the trigger. Someone asking by hand has already decided — and
    // refusing them would make it impossible to test a pipeline before switching it on.
    expect((await host.runManually('echo', { data: { title: 'x' } })).ok).toBe(true);
  });

  it('takes the body straight through when the definition selects nothing', async () => {
    writePipeline(
      'raw.yaml',
      `
key: raw
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: "{{title}}" }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`,
    );
    const seen: Array<Record<string, unknown>> = [];
    const host = await startOpsHost({
      stateDir: dir,
      operation: { run: async (_s, fields) => (seen.push(fields), { ok: true, answer: {} }) },
    });

    await host.runManually('raw', { title: 'shortest path to a working pipeline' });

    expect(seen[0]).toEqual({ title: 'shortest path to a working pipeline' });
  });
});

describe('before the AI step exists', () => {
  it('fails the run with a reason instead of pretending', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir }); // no operation runner supplied

    const { run } = await host.runManually('echo', { data: { title: 'x' } });

    expect(run).toMatchObject({ outcome: 'agent_failed', stage: 'agent' });
    expect(run?.reason).toMatch(/not wired up yet/);
  });
});

describe('loading definitions', () => {
  it('finds nothing when nothing is configured, and says so quietly', async () => {
    const host = await startOpsHost({ stateDir: dir });

    expect(host.list()).toEqual([]);
    expect(host.error).toBeUndefined();
  });

  it('keeps serving and reports why when a definition is broken', async () => {
    writePipeline('broken.yaml', 'key: "NOT A KEY"\n');

    const host = await startOpsHost({ stateDir: dir });

    // Throwing here would take the core down over a typo in a file the operator can only
    // fix through the core.
    expect(host.error).toMatch(/broken\.yaml/);
    expect(host.list()).toEqual([]);
  });

  it('keeps the pipelines it already had when a reload goes bad', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });
    expect(host.list()).toHaveLength(1);

    writePipeline('broken.yaml', 'key: "NOT A KEY"\n');
    const result = await host.load();

    expect(result.error).toBeTruthy();
    expect(host.list()).toHaveLength(1); // the good one keeps running
  });

  it('lists what the dashboard needs', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const host = await startOpsHost({ stateDir: dir });

    expect(host.list()[0]).toEqual({
      key: 'echo',
      description: 'hand the body straight back',
      enabled: true,
      trigger: 'manual',
      activeRuns: 0,
    });
  });
});

/**
 * The trial fetch exists to take the guesswork out of `select` — a path is a guess until
 * something proves it, and proving it with a real run costs a model turn.
 *
 * It was only half doing that. A path that matched nothing put `undefined` in the result,
 * `undefined` does not survive JSON on the way to the window, and the editor only drew the
 * fields block when there was something in it — so a typo produced no block at all, and the
 * response had to be compared against the paths by eye (CRL-53).
 */
describe('trying a fetch before saving', () => {
  let api: Server;
  let url = '';

  beforeEach(async () => {
    api = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { title: 'a record', note: '', tags: [] } }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/r`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => api.close(() => r()));
  });

  const tryFetch = async (select: unknown) => (await startOpsHost({ stateDir: dir })).testFetch({ url }, {}, select);

  it('names the paths that found nothing', async () => {
    const result = await tryFetch({ title: 'data.title', missed: 'data.titel' });

    expect(result).toMatchObject({ ok: true, fields: { title: 'a record' }, missing: ['missed'] });
  });

  it('does not call a blank value missing', async () => {
    // An empty string and an empty list are answers. "The field is blank" and "the path is
    // wrong" send someone looking in different places.
    const result = await tryFetch({ note: 'data.note', tags: 'data.tags' });

    expect(result.missing).toEqual([]);
    expect(result.fields).toEqual({ note: '', tags: [] });
  });

  it('says the field list was unreadable instead of returning nothing', async () => {
    // Unreachable from the editor today — it writes `name: path` lines and any non-empty
    // string is a valid selector. It stops being unreachable the day the object form is
    // offered, and the response is still worth showing either way.
    const result = await tryFetch({ title: { path: '' } });

    expect(result.ok).toBe(true);
    expect(result.selectError).toMatch(/title\.path/);
    expect(result.body).toMatchObject({ data: { title: 'a record' } });
  });

  it('still reports a request that never got a response', async () => {
    const result = await (await startOpsHost({ stateDir: dir })).testFetch({ url: 'http://127.0.0.1:1/nope' }, {}, {});

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
