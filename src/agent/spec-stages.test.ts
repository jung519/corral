/**
 * The planning ladder of spec mode: requirements → design → tasks, a human gate after each.
 *
 * Two things are load-bearing beyond "it runs". The `tasks.md` shape is fixed here because
 * CRL-105's parser will read it — changing it later breaks the parser and every task file
 * already written. And `spec_mode: single` has to stay untouched: the repo is live, and a
 * plan written before any of this still has to mean what it meant (plan doc §10).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEC } from '../core/paths.js';
import { consolidateSpecPrompt, nextSpecStage, renderWorkflow, specDoc, specStagePrompt, SPEC_STAGES } from './prompt-builder.js';
import type { Issue } from '../core/types.js';

const issue: Issue = {
  identifier: 'ISS-1',
  internalId: 'x',
  title: 'a title',
  description: '',
  state: 'in_progress',
  labels: [],
  blockedBy: [],
  attachments: [],
};
const repos = [{ key: 'server', dir: 'server', description: 'API', base_branch: 'main', branch: 'feature/ISS-1' }];
const render = () => renderWorkflow({ issue, tracker_kind: 'notion', repos }, 'WORKFLOW.md');

describe('the stage ladder', () => {
  it('runs requirements, then design, then tasks', () => {
    expect([...SPEC_STAGES]).toEqual(['requirements', 'design', 'tasks']);
    expect(nextSpecStage('requirements')).toBe('design');
    expect(nextSpecStage('design')).toBe('tasks');
  });

  it('ends after tasks — the next step is implementation, not another gate', () => {
    expect(nextSpecStage('tasks')).toBeNull();
  });

  it('gives each stage its own document', () => {
    const docs = SPEC_STAGES.map(specDoc);
    expect(docs).toEqual([SPEC.requirements, SPEC.design, SPEC.tasks]);
    expect(new Set(docs).size).toBe(3);
  });

  it('names the branch and the output file in the kickoff prompt', () => {
    // Three planning branches exist in spec mode; picking the wrong one silently produces
    // the wrong document, so neither is left to inference.
    expect(specStagePrompt(issue, 'design')).toContain('A2');
    expect(specStagePrompt(issue, 'design')).toContain(SPEC.design);
    expect(consolidateSpecPrompt('tasks')).toContain(SPEC.tasks);
  });
});

describe('the guide', () => {
  it('carries all three planning branches', async () => {
    const out = await render();
    for (const branch of ['### A1 — Requirements', '### A2 — Design', '### A3 — Tasks']) {
      expect(out).toContain(branch);
    }
  });

  it('keeps branch A for single mode', async () => {
    // Deleting it would break every in-flight issue mid-plan.
    expect(await render()).toContain('### A — Planning');
  });

  it('gives A1 the EARS forms, same as branch A', async () => {
    const out = await render();
    // One definition, used by both — so the notation cannot drift between the two modes.
    // Counted by the table's first row, which appears exactly once per rendered block.
    const blocks = out.split('| Ubiquitous (always true) |').length - 1;
    expect(blocks).toBe(2);
  });

  it('makes A2 tie every design decision to a REQ', async () => {
    const out = await render();
    expect(out).toMatch(/Every design decision names the `REQ-n` it serves/);
    // A requirement nothing covers is the failure this is guarding against.
    expect(out).toMatch(/a requirement no decision covers is a gap/);
  });
});

/**
 * CRL-105 parses this. The shape is a contract from here on, so it is pinned by example
 * rather than by prose: the guide must show a line the parser will actually accept.
 */
describe('the tasks.md shape', () => {
  const TASK_LINE = /^- \[ \] (T\d+) — (.+?) \(((?:REQ-\d+)(?:, REQ-\d+)*)\)(?: \[after: (T\d+)\])?$/;

  it('is shown in the guide as parseable lines', async () => {
    const out = await render();
    const examples = out.split('\n').filter((l) => l.startsWith('- [ ] T'));
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const line of examples) expect(line, `unparseable example: ${line}`).toMatch(TASK_LINE);
  });

  it('shows both the plain and the dependent form', async () => {
    const out = await render();
    const examples = out.split('\n').filter((l) => l.startsWith('- [ ] T'));
    expect(examples.some((l) => l.includes('[after: T'))).toBe(true);
    expect(examples.some((l) => !l.includes('[after: T'))).toBe(true);
  });

  it('carries multiple REQ references on one task', async () => {
    const out = await render();
    const multi = out.split('\n').filter((l) => l.startsWith('- [ ] T')).find((l) => l.includes(', REQ-'));
    expect(multi, 'no example shows a task serving more than one requirement').toBeDefined();
  });

  it('tells the agent not to tick the boxes', async () => {
    // The implementation ticks them as it commits; a plan that arrives pre-ticked would
    // make the progress read as finished before anything ran.
    expect(await render()).toMatch(/Do not tick any box/);
  });
});

/**
 * The orchestrator has no test harness (its constructor takes eleven collaborators), so the
 * flow is pinned by reading it — the same technique `ops/boundaries.test.ts` uses for the
 * import wall.
 */
describe('the flow, read from the source', () => {
  const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

  it('only enters the ladder when spec mode is on', () => {
    expect(ORCHESTRATOR).toMatch(/this\.config\.spec_mode === 'split'/);
  });

  it('leaves the single-plan path reachable', () => {
    // `spec_mode` defaults to single, and an in-flight issue must still be able to finish
    // the plan it started.
    expect(ORCHESTRATOR).toContain('kickoffPrompt(issue)');
    expect(ORCHESTRATOR).toContain('PROMPTS.consolidatePlan');
  });

  it('never declares a spec document as a dispatch output', () => {
    // Every stage reads the previous stages' documents; declaring one would blank a later
    // turn's input, which is the failure CRL-88 fixed. (Also pinned in scratch-outputs.)
    const flat = ORCHESTRATOR.replace(/\s+/g, ' ');
    const calls = [...flat.matchAll(/this\.dispatch\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0]);
    expect(calls.filter((c) => c.includes('SPEC.') || c.includes('specDoc'))).toEqual([]);
  });

  it('gates every stage and hands the last one to implementation', () => {
    expect(ORCHESTRATOR).toContain("case 'requirements_sent':");
    expect(ORCHESTRATOR).toContain("case 'design_sent':");
    expect(ORCHESTRATOR).toContain("case 'tasks_sent':");
    // nextSpecStage returns null after tasks; that branch must start the implementation.
    expect(ORCHESTRATOR).toMatch(/const next = nextSpecStage\(stage\)[\s\S]*?implementAndReview/);
  });

  it('clears the stage marker on the way into implementation', () => {
    // Left set, a later restart would try to resume vetting a stage already approved.
    expect(ORCHESTRATOR).toMatch(/rt\.specStage = undefined;[\s\S]{0,120}implementAndReview/);
  });

  it('resumes the right document after a restart', () => {
    // One `plan_reviewing` covers both modes; `specStage` says which document it was.
    expect(ORCHESTRATOR).toMatch(/const stage = rt\.specStage as SpecStage \| undefined;/);
    expect(ORCHESTRATOR).toMatch(/const doc = stage \? specDoc\(stage\) : SCRATCH\.pendingPlan;/);
  });
});
