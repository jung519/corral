/**
 * The manual run is the only way in before any trigger exists — it's how a pipeline gets
 * tried out while it's being written, and how a failed one gets reprocessed. So it has to
 * work with nothing configured but a definition file, and it has to leave a trace.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOpsHost, UnwiredAnswerValidator } from './ops-host.js';
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
      operation: { run: async (_s, fields) => (seen.push(fields), { answer: {} }) },
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

  it('refuses a pipeline whose rules it cannot enforce, rather than skipping them', async () => {
    const validator = new UnwiredAnswerValidator();

    // Passing everything through would mean that the day the model step is wired before
    // the rule engine, every declared rule silently does nothing.
    expect(await validator.check({ validate: { max_items: {} } }, { a: 1 })).toMatchObject({ ok: false });
    expect(await validator.check({ validate: {} }, { a: 1 })).toMatchObject({ ok: true });
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
