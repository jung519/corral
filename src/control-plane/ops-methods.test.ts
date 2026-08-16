/**
 * The operational-AI methods on the control plane — the only way to run a pipeline before
 * any trigger exists.
 *
 * These live here rather than under `ops/` on purpose: they need both the operational AI
 * and the shared control plane, and `ops/` is not allowed to reach across (the boundary
 * test enforces exactly that). The shared layer is where the two are allowed to meet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { TokenBudget } from '../core/token-budget.js';
import { OpsHost, startOpsHost } from '../ops/ops-host.js';
import type { OperationRunner } from '../ops/pipeline/ports.js';
import { dispatch, type ControlPlaneDeps } from './dispatch.js';

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

const stubModel: OperationRunner = {
  run: async (_step, fields) => ({ answer: { answer: `saw ${String(fields.title)}` }, tokens: 42, provider: 'claude' }),
};

function writePipeline(name: string, body: string): void {
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(join(dir, 'pipelines', name), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-ops-methods-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it('declines cleanly on a core with no operational AI', async () => {
    const d = deps(undefined);

    for (const method of ['opsPipelines', 'opsRun', 'opsHistory', 'opsTotals', 'opsSetEnabled', 'opsSave']) {
      expect(await dispatch(method, {}, d)).toMatchObject({ ok: false });
    }
  });

  it('names an unknown pipeline rather than silently doing nothing', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect((await dispatch('opsSetEnabled', { key: 'ghost', enabled: true }, d)) as any).toMatchObject({ ok: false });
    expect((await dispatch('opsRun', { key: 'ghost' }, d)) as any).toMatchObject({ ok: false });
  });
});
