/**
 * The operational-AI methods on the control plane — the only way to run a pipeline before
 * any trigger exists.
 *
 * These live here rather than under `ops/` on purpose: they need both the operational AI
 * and the shared control plane, and `ops/` is not allowed to reach across (the boundary
 * test enforces exactly that). The shared layer is where the two are allowed to meet.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { DirectionCheckStore, DirectionStore } from '../core/direction.js';
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

  it('reports a load error alongside the empty list', async () => {
    writePipeline('broken.yaml', 'key: "NOT A KEY"\n');
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect((await dispatch('opsPipelines', {}, d)) as any).toMatchObject({ pipelines: [], error: expect.stringContaining('broken.yaml') });
  });

  it('picks up a definition added while the core was running', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));
    expect(((await dispatch('opsPipelines', {}, d)) as any).pipelines).toEqual([]);

    writePipeline('echo.yaml', PIPELINE);

    expect((await dispatch('opsReload', {}, d)) as any).toEqual({ loaded: 1 });
  });

  it('declines cleanly on a core with no operational AI', async () => {
    const d = deps(undefined);

    for (const method of ['opsPipelines', 'opsRun', 'opsHistory', 'opsTotals', 'opsSetEnabled', 'opsReload']) {
      expect(await dispatch(method, {}, d)).toMatchObject({ ok: false });
    }
  });

  it('names an unknown pipeline rather than silently doing nothing', async () => {
    const d = deps(await startOpsHost({ stateDir: dir }));

    expect((await dispatch('opsSetEnabled', { key: 'ghost', enabled: true }, d)) as any).toMatchObject({ ok: false });
    expect((await dispatch('opsRun', { key: 'ghost' }, d)) as any).toMatchObject({ ok: false });
  });
});
