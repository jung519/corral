/**
 * The operational-AI methods on the control plane — the only way to run a pipeline before
 * any trigger exists.
 *
 * These live here rather than under `ops/` on purpose: they need both the operational AI
 * and the shared control plane, and `ops/` is not allowed to reach across (the boundary
 * test enforces exactly that). The shared layer is where the two are allowed to meet.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { TokenBudget } from '../core/token-budget.js';
import { FileCredentialStore } from '../credentials/file-store.js';
import { OpsHost, startOpsHost } from '../ops/ops-host.js';
import type { OperationRunner } from '../ops/pipeline/ports.js';
import { dispatch, type ControlPlaneDeps } from './dispatch.js';

let dir: string;
/** A stand-in for the user's own API, for the trial-fetch tests. */
let server: Server;
let base: string;
let requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
let status = 200;

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

const stubModel: OperationRunner = {
  run: async (_step, fields) => ({ answer: { answer: `saw ${String(fields.title)}` }, tokens: 42, provider: 'claude' }),
};

function writePipeline(name: string, body: string): void {
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(join(dir, 'pipelines', name), body);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'corral-ops-methods-'));
  requests = [];
  status = 200;
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { title: 'hello' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('over the control plane', () => {
  function deps(ops?: OpsHost): ControlPlaneDeps {
    return {
      channel: new WebChannel(),
      orchestrator: () => undefined,
      directionStore: new DirectionStore(join(dir, 'direction.md')),
      directionCheck: new DirectionCheckStore(dir),
      ops,
    };
  }

  it('runs a pipeline and hands back the record', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const d = deps(await startOpsHost({ stateDir: dir, operation: stubModel }));

    const result = (await dispatch('opsRun', { key: 'echo', input: { data: { title: 'x' } } }, d)) as any;

    expect(result).toMatchObject({ ok: true, run: { outcome: 'completed' } });
  });

  it('lists pipelines, toggles one, and reads back the history', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const d = deps(await startOpsHost({ stateDir: dir, operation: stubModel }));
    await dispatch('opsRun', { key: 'echo', input: {} }, d);

    expect((await dispatch('opsPipelines', {}, d)) as any).toMatchObject({ pipelines: [{ key: 'echo', enabled: true }] });
    expect((await dispatch('opsSetEnabled', { key: 'echo', enabled: false }, d)) as any).toEqual({ ok: true, enabled: false });
    expect(((await dispatch('opsHistory', { days: 1 }, d)) as any).runs).toHaveLength(1);
    expect(((await dispatch('opsTotals', { days: 1 }, d)) as any).totals[0].runs).toBe(1);
  });

  it('answers the whole dashboard in one call', async () => {
    writePipeline('echo.yaml', PIPELINE);
    const budget = new TokenBudget({ dailyInputTokens: 1000 }, dir);
    const d = deps(await startOpsHost({ stateDir: dir, operation: stubModel, budget }));
    await dispatch('opsRun', { key: 'echo', input: { data: { title: 'x' } } }, d);

    const view = (await dispatch('opsPipelines', {}, d)) as any;

    // One round trip, so every panel describes the same moment — and so a polling
    // dashboard does not cost three requests per tick.
    expect(view.pipelines[0]).toMatchObject({ key: 'echo', enabled: true, trigger: 'manual' });
    expect(view.counts.echo).toMatchObject({ runs: 1, failed: 0 });
    expect(view.budget).toMatchObject({ inputTokens: expect.any(Number) });
  });

  it('leaves the budget out when no ceiling is wired, rather than inventing zeroes', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect(((await dispatch('opsPipelines', {}, d)) as any).budget).toBeUndefined();
  });

  it('carries the shared budget even when no pipeline caused the usage', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 1000 }, dir);
    budget.record({ inputTokens: 400, outputTokens: 0 }); // as if an issue had been planned
    const d = deps(await startOpsHost({ stateDir: dir, budget }));

    const view = (await dispatch('opsPipelines', {}, d)) as any;

    // A pipeline can stop for a reason that has nothing to do with pipelines.
    expect(view.budget).toMatchObject({ inputTokens: 400, used: 0.4 });
  });

  it('reports a load error alongside the empty list', async () => {
    writePipeline('broken.yaml', 'key: "NOT A KEY"\n');
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect((await dispatch('opsPipelines', {}, d)) as any).toMatchObject({ pipelines: [], error: expect.stringContaining('broken.yaml') });
  });

  it('saves a definition and picks it up without a restart', async () => {
    const d = deps(await startOpsHost({ stateDir: dir, operation: stubModel }));

    const saved = (await dispatch(
      'opsSave',
      {
        definition: {
          key: 'from-the-app',
          trigger: { kind: 'manual' },
          input: { kind: 'none' },
          agent: {
            prompt: { system: 's', user_template: 'u' },
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
          output: { kind: 'none' },
        },
      },
      d,
    )) as any;

    // Someone who just pressed save expects the pipeline to be there.
    expect(saved).toMatchObject({ ok: true, file: 'from-the-app.yaml' });
    expect(((await dispatch('opsPipelines', {}, d)) as any).pipelines[0].key).toBe('from-the-app');
    expect(((await dispatch('opsRun', { key: 'from-the-app', input: {} }, d)) as any).ok).toBe(true);
  });

  it('hands back field paths instead of saving something broken', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));

    const saved = (await dispatch('opsSave', { definition: { key: 'BAD KEY' } }, d)) as any;

    expect(saved.ok).toBe(false);
    expect(saved.issues.map((i: { path: string }) => i.path)).toContain('key');
    expect(((await dispatch('opsPipelines', {}, d)) as any).pipelines).toEqual([]);
  });

  it('keeps the file editable by hand afterwards', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));
    await dispatch(
      'opsSave',
      {
        definition: {
          key: 'both-ways',
          trigger: { kind: 'manual' },
          input: { kind: 'none' },
          agent: {
            prompt: { system: 's', user_template: 'u' },
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
          output: { kind: 'none' },
        },
      },
      d,
    );

    // The app is a convenient way to write the file, not a database that owns it — what
    // it wrote is still ordinary YAML someone can edit. Picking the edit up is a restart,
    // deliberately: editing a program's files behind its back is the editor's risk to
    // carry, not something the app owes a button for.
    const file = join(dir, 'pipelines', 'both-ways.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('key: both-ways', 'key: both-ways\ndescription: edited by hand'));

    const restarted = deps(await startOpsHost({ stateDir: dir }));

    expect(((await dispatch('opsPipelines', {}, restarted)) as any).pipelines[0].description).toBe('edited by hand');
  });

  describe('trying a fetch before saving', () => {
    it('returns the response and what the paths pulled out of it', async () => {
      const d = deps(await startOpsHost({ stateDir: dir }));

      const r = (await dispatch(
        'opsTestFetch',
        {
          request: { method: 'GET', url: `${base}/api/records/{{id}}` },
          event: { id: '7' },
          select: { title: 'data.title' },
        },
        d,
      )) as any;

      // The URL was built from the sample event, so `{{id}}` can be checked before saving.
      expect(requests[0].url).toBe('/api/records/7');
      expect(r).toMatchObject({ ok: true, body: { data: { title: 'hello' } }, fields: { title: 'hello' } });
    });

    it('resolves the credential the same way a run would', async () => {
      const credentials = new FileCredentialStore(join(dir, 'c.json'));
      await credentials.set({ service: 'backend', account: 'default' }, 'super-secret');
      const d = deps(await startOpsHost({ stateDir: dir, credentials }));

      await dispatch(
        'opsTestFetch',
        {
          request: {
            url: `${base}/r`,
            credential: { service: 'backend', account: 'default' },
            auth: { header: 'X-API-Key', prefix: '' },
          },
          event: {},
          select: {},
        },
        d,
      );

      // Which is the point: what you tried is what will run.
      expect(requests[0].headers['x-api-key']).toBe('super-secret');
    });

    it('answers with the failure rather than throwing it', async () => {
      status = 401;
      const d = deps(await startOpsHost({ stateDir: dir }));

      const r = (await dispatch('opsTestFetch', { request: { url: `${base}/r` }, event: {}, select: {} }, d)) as any;

      // "the server said 401" is the answer someone pressed this to get.
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/401/);
    });

    it('says which field is wrong when the request itself is not one', async () => {
      const d = deps(await startOpsHost({ stateDir: dir }));

      const r = (await dispatch('opsTestFetch', { request: { method: 'GET' }, event: {}, select: {} }, d)) as any;

      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('url') });
    });
  });

  describe('deleting one', () => {
    it('removes the file and the pipeline with it', async () => {
      writePipeline('echo.yaml', PIPELINE);
      const d = deps(await startOpsHost({ stateDir: dir }));

      expect((await dispatch('opsDelete', { key: 'echo' }, d)) as any).toMatchObject({ ok: true, file: 'echo.yaml' });

      expect(existsSync(join(dir, 'pipelines', 'echo.yaml'))).toBe(false);
      expect(((await dispatch('opsPipelines', {}, d)) as any).pipelines).toEqual([]);
    });

    it('finds the file by its key, whatever it is called', async () => {
      // Assuming `<key>.yaml` would leave a hand-named file behind, and the pipeline with
      // it — the same reason saving looks the file up rather than guessing.
      writePipeline('some-other-name.yml', PIPELINE);
      const d = deps(await startOpsHost({ stateDir: dir }));

      expect((await dispatch('opsDelete', { key: 'echo' }, d)) as any).toMatchObject({ ok: true, file: 'some-other-name.yml' });
      expect(existsSync(join(dir, 'pipelines', 'some-other-name.yml'))).toBe(false);
    });

    it('stops the trigger, so nothing fires afterwards', async () => {
      writePipeline('nightly.yaml', PIPELINE.replace('trigger: { kind: manual }', 'trigger: { kind: schedule, cron: "* * * * *" }'));
      const ops = await startOpsHost({ stateDir: dir });
      expect(ops.running()).toEqual(['echo']);

      await dispatch('opsDelete', { key: 'echo' }, deps(ops));

      expect(ops.running()).toEqual([]);
    });

    it('keeps the run history — what ran is not what is configured', async () => {
      writePipeline('echo.yaml', PIPELINE);
      const ops = await startOpsHost({ stateDir: dir, operation: stubModel });
      const d = deps(ops);
      await dispatch('opsRun', { key: 'echo', input: { data: { title: 'hello' } } }, d);

      await dispatch('opsDelete', { key: 'echo' }, d);

      // Deleting the record of last night's failures along with the definition would
      // remove the only way to find out why it was deleted.
      expect((await ops.history.list({ days: 1 })).map((r) => r.pipeline)).toEqual(['echo']);
    });

    it('lets a run that is already going finish', async () => {
      // Killing one mid-flight can leave half of it written into someone's system.
      // Deleting a definition is not a reason to do that — and the dialog says so.
      writePipeline('echo.yaml', PIPELINE);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const slow: OperationRunner = {
        run: async () => {
          await held;
          return { answer: { answer: 'finished anyway' }, tokens: 1 };
        },
      };
      const ops = await startOpsHost({ stateDir: dir, operation: slow });
      const d = deps(ops);

      const running = dispatch('opsRun', { key: 'echo', input: { data: { title: 'x' } } }, d);
      await dispatch('opsDelete', { key: 'echo' }, d);
      release();

      expect((await running) as any).toMatchObject({ ok: true, run: { outcome: 'completed' } });
      expect(((await dispatch('opsPipelines', {}, d)) as any).pipelines).toEqual([]);
    });

    it('says so rather than quietly succeeding on a key that is not there', async () => {
      const d = deps(await startOpsHost({ stateDir: dir }));

      expect((await dispatch('opsDelete', { key: 'nope' }, d)) as any).toMatchObject({
        ok: false,
        error: expect.stringContaining('nope'),
      });
    });
  });

  it('declines cleanly on a core with no operational AI', async () => {
    const d = deps(undefined);

    for (const method of ['opsPipelines', 'opsRun', 'opsHistory', 'opsTotals', 'opsSetEnabled', 'opsSave', 'opsDelete', 'opsTestFetch']) {
      expect(await dispatch(method, {}, d)).toMatchObject({ ok: false });
    }
  });

  it('names an unknown pipeline rather than silently doing nothing', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect((await dispatch('opsSetEnabled', { key: 'ghost', enabled: true }, d)) as any).toMatchObject({ ok: false });
    expect((await dispatch('opsRun', { key: 'ghost' }, d)) as any).toMatchObject({ ok: false });
  });
});
