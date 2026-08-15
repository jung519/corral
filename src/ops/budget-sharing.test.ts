/**
 * The point of the shared ceiling: spending on one side stops the other.
 *
 * Tested through the pieces that actually meet — `CostTracker`, which every
 * development-AI run funnels through, and the pipeline lifecycle, which is where an
 * operational run asks permission.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from '../core/cost-tracker.js';
import { TokenBudget } from '../core/token-budget.js';
import { startOpsHost } from './ops-host.js';
import type { OperationRunner } from './pipeline/ports.js';

let dir: string;

const PIPELINE = `
key: classify
trigger: { kind: manual }
input: { kind: none }
agent:
  prompt: { system: s, user_template: u }
  schema: { type: object, properties: { answer: { type: string } } }
output: { kind: none }
`;

/** A model step that spends a known amount. */
const spends = (inputTokens: number, outputTokens: number): OperationRunner => ({
  run: async () => ({ answer: { answer: 'ok' }, inputTokens, outputTokens, tokens: inputTokens + outputTokens }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-budget-share-'));
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(join(dir, 'pipelines', 'classify.yaml'), PIPELINE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('development spending blocks operational runs', () => {
  it('stops the pipeline once an issue has used the day up', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 100 }, dir);
    const host = await startOpsHost({ stateDir: dir, budget, operation: spends(10, 5) });

    expect((await host.runManually('classify', {})).run?.outcome).toBe('completed');

    // An issue being planned, nothing to do with pipelines — same account, same day.
    new CostTracker(dir, budget).add('ISS-1', { costUsd: 1, inputTokens: 200, outputTokens: 0 });

    const { run } = await host.runManually('classify', {});
    expect(run).toMatchObject({ outcome: 'over_budget', stage: 'agent' });
    expect(run?.reason).toMatch(/daily input token limit reached/);
  });

  it('leaves the run as its own outcome, not a failure', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 1 }, dir);
    budget.record({ inputTokens: 5, outputTokens: 0 });
    const host = await startOpsHost({ stateDir: dir, budget, operation: spends(10, 5) });

    const { run } = await host.runManually('classify', {});

    // A failure invites the trigger to redeliver, and redelivering into a spent budget
    // all day is exactly the retry storm to avoid. Nothing is fixable until tomorrow.
    expect(run?.outcome).toBe('over_budget');
    expect(run?.outcome).not.toBe('agent_failed');
    expect(run?.tokens).toBeUndefined(); // the model was never called
  });
});

describe('operational spending blocks development runs', () => {
  it('closes the door after enough pipeline runs', async () => {
    const budget = new TokenBudget({ dailyOutputTokens: 100 }, dir);
    const host = await startOpsHost({ stateDir: dir, budget, operation: spends(0, 60) });

    expect(budget.check().ok).toBe(true);
    await host.runManually('classify', {});
    await host.runManually('classify', {});

    // What the orchestrator checks before dispatching an issue.
    expect(budget.check()).toMatchObject({ ok: false, reason: expect.stringContaining('output token limit') });
  });
});

describe('what gets counted', () => {
  it('counts a turn whose answer was rejected', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 1000 }, dir);
    const host = await startOpsHost({
      stateDir: dir,
      budget,
      // A well-formed reply that the schema check will throw out.
      operation: { run: async () => ({ answer: {}, inputTokens: 300, outputTokens: 10 }) },
    });

    await host.runManually('classify', {});

    // A rejected answer still cost tokens; a ceiling that only counted useful calls
    // would not be a ceiling.
    expect(budget.snapshot().inputTokens).toBe(300);
  });

  it('counts nothing for a run that never reached the model', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 1000 }, dir);
    const host = await startOpsHost({ stateDir: dir, budget, operation: spends(50, 50) });

    await host.runManually('nope', {}); // unknown pipeline

    expect(budget.snapshot()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
