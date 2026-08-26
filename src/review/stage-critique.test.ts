/**
 * How much critique each planning stage gets, and what happens when the answer is none.
 *
 * Two things were fused. `plan_review` was global, so spec mode ran a critique on all three
 * stages whether or not it earned its place — and the consolidation turn that folds critiques
 * in ran unconditionally, so switching the critique off still paid for a dispatch that had
 * nothing to fold. Measured on one issue, critique + consolidation was 43 of the 72 minutes
 * planning took (CRL-130).
 *
 * The default must stay exactly what it was: a config that does not mention `stages` is every
 * config that exists today.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanCritiqueOrchestrator } from './plan-critique.js';
import { PlanReviewSchema } from '../config/schema.js';
import { resolveProfile } from '../profile/index.js';
import { ProfileSchema } from '../config/schema.js';
import type { AgentAdapter, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';

const issue: Issue = {
  identifier: 'ISS-1', internalId: 'x', title: 't', description: '',
  state: 'in_progress', labels: [], blockedBy: [], attachments: [],
};
const handle: WorkspaceHandle = { id: 'ISS-1', workdir: '/w', backend: 'local' };

let dir: string;
let runs: number;
let execs: string[];

const io = (): WorkspaceIO =>
  ({
    exec: async (_h: WorkspaceHandle, cmd: string) => {
      execs.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    },
    readFile: async () => null,
    writeFile: async () => {},
  }) as unknown as WorkspaceIO;

const agent = (): AgentAdapter =>
  ({
    run: async () => {
      runs += 1;
      return { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: 0 };
    },
  }) as unknown as AgentAdapter;

const orch = (cfg: unknown) =>
  new PlanCritiqueOrchestrator(io(), agent(), PlanReviewSchema.parse(cfg), resolveProfile(ProfileSchema.parse({})));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crl130-'));
  runs = 0;
  execs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a config that says nothing about stages', () => {
  it('runs the configured number of rounds, as it always did', async () => {
    const files = await orch({}).run(handle, issue, { target: '.corral/spec/requirements.md' });
    expect(runs).toBe(1);
    expect(files).toHaveLength(1);
  });

  it('still honours heavy_rounds for a labelled issue', async () => {
    const heavy = { ...issue, labels: ['big'] };
    await orch({ heavy_labels: ['big'], heavy_rounds: 3 }).run(handle, heavy);
    expect(runs).toBe(3);
  });
});

describe('a stage set to zero', () => {
  it('runs no critique and reports none', async () => {
    const files = await orch({ stages: { design: 0 } }).run(handle, issue, { rounds: 0 });
    expect(runs).toBe(0);
    expect(files).toEqual([]);
  });

  it('leaves the workspace alone — no wipe, no writes', async () => {
    // The wipe exists so a shortened run cannot leave a higher-numbered file behind. With
    // no rounds there is nothing to shorten, and wiping would take another stage's output.
    await orch({}).run(handle, issue, { rounds: 0 });
    expect(execs).toEqual([]);
  });

  it('is not the same as the whole feature being off', async () => {
    // `enabled: false` silences every stage; a zero here silences one.
    await orch({ stages: { tasks: 0 } }).run(handle, issue);
    expect(runs).toBe(1);
  });
});

describe('the count a caller asks for', () => {
  it('wins over the configured one', async () => {
    await orch({ rounds: 1 }).run(handle, issue, { rounds: 2 });
    expect(runs).toBe(2);
  });

  it('is ignored when the whole feature is off', async () => {
    await orch({ enabled: false }).run(handle, issue, { rounds: 3 });
    expect(runs).toBe(0);
  });
});

/**
 * The other half: a consolidation turn that ran whether or not there was anything to
 * consolidate. Read from the source — the orchestrator takes eleven collaborators and there
 * is no harness, the same reason `ops/boundaries.test.ts` and `spec-seams.test.ts` read
 * source (CRL-130).
 */
describe('consolidation is skipped when nothing was critiqued', () => {
  const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');
  const slice = (from: string, to: string) => ORCHESTRATOR.slice(ORCHESTRATOR.indexOf(from), ORCHESTRATOR.indexOf(to));

  const single = slice('private async vetAndSendPlan', 'private async runSpecStage');
  const spec = slice('private async vetAndSendSpec', 'private async resumeVetting');

  it.each([
    ['single mode', () => single],
    ['spec mode', () => spec],
  ])('%s guards the consolidate dispatch on the critique result', (_label, get) => {
    const body = get();
    expect(body).toMatch(/const critiques = await this\.planCritique\.run\(/);
    const guard = body.indexOf('if (critiques.length > 0)');
    const dispatch = body.indexOf('consolidate = await this.dispatch');
    expect(guard).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(guard);
  });

  it('does not copy the draft either — that guard was for consolidation overwriting it', () => {
    const guard = spec.indexOf('if (critiques.length > 0)');
    expect(spec.indexOf('SCRATCH.planDraft')).toBeGreaterThan(guard);
  });

  it('still raises the approval card when the critique was skipped', () => {
    // The whole point: the draft goes to the human. `sendApproval` sits outside the guard.
    const guardEnd = spec.indexOf('const body = await this.readOutput');
    expect(guardEnd).toBeGreaterThan(spec.indexOf('if (critiques.length > 0)'));
    expect(spec.slice(guardEnd)).toContain('sendApproval');
  });

  it('reads the per-stage count from config, not from a constant', () => {
    expect(spec).toMatch(/rounds: this\.config\.plan_review\.stages\[stage\]/);
  });
});
