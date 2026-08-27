/**
 * What stops a plan from growing past the point a person can read it.
 *
 * The measurement that prompted this: one issue produced forty acceptance criteria for a
 * rule applied across twelve files, and three documents totalling 110,907 bytes. The work
 * behind them was eleven commits. Nobody could read that and judge it — and an approval
 * nobody can read is not an approval, which is the whole reason the gates exist (CRL-129).
 *
 * Four forces pushed it there, and each has a counterweight asserted here:
 *
 *   one rule per call site        → merge into the ubiquitous form
 *   no ceiling on the count       → twelve for an ordinary issue
 *   critique adds, nothing cuts   → consolidation removes too, and the critic looks for merges
 *   process notes inside the doc  → they go in a file beside it
 *
 * The guide already warned against the first one — "Do not force an invariant into WHEN" —
 * and the run produced twenty WHENs anyway. So these assert the *rules*, not the warning;
 * whether they actually work is a measurement, not a test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderWorkflow } from './prompt-builder.js';
import { planCritiquePrompt, reviewRoundPrompt } from '../review/prompt.js';
import { resolveProfile } from '../profile/index.js';
import { ProfileSchema } from '../config/schema.js';
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
const GUIDE = readFileSync(new URL('../../WORKFLOW.md', import.meta.url), 'utf8');

describe('how many criteria a plan may have', () => {
  it('says one rule is one criterion however many call sites it has', async () => {
    expect(await render()).toMatch(/\*\*One rule is one criterion, however many places it applies\.\*\*/);
  });

  it('gives the ceiling as a number, not as an exhortation', async () => {
    // "Be concise" is what the review prompt said, and reviews were still walls of text.
    expect(await render()).toMatch(/\*\*Twelve criteria is the ceiling for an ordinary issue\.\*\*/);
  });

  it('says what to do when an issue genuinely needs more', async () => {
    // The escape hatch matters: without one, the ceiling becomes a reason to under-specify.
    expect(await render()).toMatch(/it is more than one issue: say so in the document/);
  });
});

describe('length rules reach every planning branch', () => {
  /** The captured block is the single definition; each branch pulls it in. */
  it('is defined once and used by all four', () => {
    expect(GUIDE).toContain('{%- capture plan_length -%}');
    const uses = GUIDE.split('{{ plan_length }}').length - 1;
    expect(uses).toBe(4);
  });

  it('names the reader and the budget, not just "be brief"', async () => {
    const out = await render();
    expect(out).toMatch(/\*\*A human has to read this and decide\.\*\*/);
    expect(out).toMatch(/readable in five minutes/);
  });

  it('carries over the rule the review report already follows', async () => {
    // Not invented here: the consolidate-review section has said this all along, and the
    // planning branches simply never did.
    const out = await render();
    const both = out.match(/NEVER write a multi-sentence paragraph/g) ?? [];
    expect(both.length).toBeGreaterThan(1);
  });

  it('tells the design not to restate the requirements', async () => {
    // Each later stage re-reads the earlier documents in full, so a restatement is paid for
    // again at every stage after it.
    expect(await render()).toMatch(/\*\*Do not restate the requirements\.\*\*/);
  });

  it('keeps tasks.md to the checklist', async () => {
    expect(await render()).toMatch(/\*\*Nothing but the checklist\.\*\*/);
  });
});

describe('consolidation', () => {
  it('is told to cut, not only to fold in', async () => {
    // A critique hunts for what is missing, so folding one in can only grow the document.
    expect(await render()).toMatch(/\*\*Consolidating cuts as well as adds\.\*\*/);
  });

  it('does not forbid growth outright — a real BLOCKER earns room', async () => {
    // Measured: "come out no longer than you went in" was ignored, and rightly — four
    // blockers landed and the document grew 40%. The rule that survives is that growth is
    // paid for, not that it never happens.
    expect(await render()).toMatch(/\*\*Pay for what you add\*\*/);
    expect(await render()).toMatch(/name\s+what came out to make room for it/);
  });

  it('asks for the record as a file, in the imperative the other outputs use', async () => {
    // Measured: a descriptive "the record goes in X" produced no file at all — the agent
    // reported the same content in its reply, which is not saved anywhere.
    const out = await render();
    expect(out).toMatch(/\*\*Write the record of what each critique point changed to `\.corral\/critique_response\.md`\*\*/);
    expect(out).toMatch(/do not leave it only in your reply/);
  });
});

describe('the critics', () => {
  const profile = resolveProfile(ProfileSchema.parse({}));

  it('the plan critic looks for criteria that should be merged', () => {
    const p = planCritiquePrompt(issue, 1, profile);
    expect(p).toMatch(/Criteria that say the SAME rule at different call sites/);
  });

  it('the plan critic judges length as a defect in its own right', () => {
    const p = planCritiquePrompt(issue, 1, profile);
    expect(p).toMatch(/cannot be read in five minutes/);
  });

  it('the plan critic still asks for more where something is genuinely missing', () => {
    // Cutting is added to the critique, not swapped in for it. A critic that only merged
    // would let a real gap through — the thing critique exists for.
    const p = planCritiquePrompt(issue, 1, profile);
    expect(p).toMatch(/missing edge cases, failure modes, concurrency, data migration/);
  });

  it('a review round is given the shape its consolidation expects', () => {
    // Rounds that arrive as prose walls get folded in as prose walls.
    const p = reviewRoundPrompt(issue, 1, [{ repoKey: 'server', dir: 'server' }] as never, profile);
    expect(p).toMatch(/ONE short sentence per bullet/);
  });
});

describe('the PR body', () => {
  it('has a shape at all', async () => {
    // It had none: the guide said `{"title": "…", "body": "…"}` and stopped there.
    expect(await render()).toMatch(/\*\*The body is read by people who were not here\.\*\*/);
  });

  it('names what to leave out', async () => {
    // The failure mode is pasting the plan in, which is exactly what nobody needs twice.
    expect(await render()).toMatch(/Do NOT put in the body: the plan or requirements restated/);
  });

  it('keeps the one thing worth the space', async () => {
    expect(await render()).toMatch(/If a finding was\s+left unresolved at approval, say so in one line/);
  });
});
