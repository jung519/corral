/**
 * The joins between the spec-mode pieces.
 *
 * Each of CRL-101…110 verified its own part. The dogfood issue exists because that is not
 * the same as the parts fitting together — and this session proved the point twice already
 * (CRL-106 left an instruction the agent could not follow, CRL-107 shipped a viewer that
 * showed the previous issue's documents). Both were found at a seam, not inside a piece.
 *
 * These are read from the source: the orchestrator's constructor takes eleven collaborators
 * and there is no harness, so the same technique `ops/boundaries.test.ts` uses for the
 * import wall applies here (CRL-113).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');
const GUIDE = readFileSync(new URL('../../WORKFLOW.md', import.meta.url), 'utf8');

/** The `question_sent` branch of the feedback handler. */
const answerBranch = ORCHESTRATOR.slice(
  ORCHESTRATOR.indexOf("if (rt.phase === 'question_sent')"),
  ORCHESTRATOR.indexOf('const signal = this.signals.feedback(text)'),
);

describe('answering a question raised by a spec stage', () => {
  /**
   * The guide tells the agent to write a question instead of the document when it needs a
   * decision (A1 step 3), and it does — the first measured A1 run did exactly that. The
   * answer used to be routed through the single-plan path, which reads `pending_plan.md`;
   * in spec mode that file does not exist, so the run stopped on "Plan file is empty" and
   * the reply, plus the turn it bought, was discarded.
   */
  it('goes back to the stage that asked, not into the single-plan flow', () => {
    expect(answerBranch).toMatch(/const stage = rt\.specStage as SpecStage \| undefined;/);
    expect(answerBranch).toMatch(/vetAndSendSpec\(rt, issue, [^,]+, stage\)/);
  });

  it('does not send a spec answer through afterPlanProduced', () => {
    const specPath = answerBranch.slice(answerBranch.indexOf('if (stage)'), answerBranch.indexOf('const result ='));
    expect(specPath).not.toContain('afterPlanProduced');
    expect(specPath).not.toContain('SCRATCH.pendingPlan');
  });

  it('leaves the single-plan answer exactly as it was', () => {
    // Everything outside spec mode still reads and writes pending_plan.md.
    const plainPath = answerBranch.slice(answerBranch.indexOf('const result ='));
    expect(plainPath).toContain('SCRATCH.pendingPlan');
    expect(plainPath).toContain("afterPlanProduced(rt, issue, 'plan')");
  });

  it('does not declare the spec documents as the answer turn\'s output', () => {
    // The answer writes the current stage's document while the earlier stages' documents
    // are its input (CRL-88).
    const specPath = answerBranch.slice(answerBranch.indexOf('if (stage)'), answerBranch.indexOf('const result ='));
    expect(specPath).not.toContain('SPEC.');
  });
});

describe('which approval cards offer options', () => {
  const sendSpec = ORCHESTRATOR.slice(
    ORCHESTRATOR.indexOf('private async vetAndSendSpec'),
    ORCHESTRATOR.indexOf('private async resumeVetting'),
  );

  /**
   * `plan_options.json` is written by branch A and by A2 (design) — nowhere else. Offering
   * it on every gate meant the task card re-presented the design alternatives the human had
   * already chosen between, and the selection travelled on into the implementation prompt.
   */
  it('only the design stage does', () => {
    expect(sendSpec).toMatch(/stage === 'design' \? await this\.planOptionsFor\(handle\) : undefined/);
  });

  it('the guide agrees about who writes the file', () => {
    // If a future stage starts writing options, this pair is what should be revisited.
    const branches = ['### A — Planning', '### A1 — Requirements', '### A2 — Design', '### A3 — Tasks'];
    const writers = branches.filter((b) => {
      const start = GUIDE.indexOf(b);
      const next = branches.map((x) => GUIDE.indexOf(x)).filter((i) => i > start);
      return GUIDE.slice(start, Math.min(...next, GUIDE.length)).includes('plan_options.json');
    });
    expect(writers).toEqual(['### A — Planning', '### A2 — Design']);
  });

  it('a stage clears the previous one\'s options on the way in', () => {
    // The file is not stage-scoped; a leftover would answer for a stage that never wrote
    // one — the staleness CRL-87 fixed for critique files.
    const runStage = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf('private async runSpecStage'),
      ORCHESTRATOR.indexOf('private async vetAndSendSpec'),
    );
    expect(runStage).toMatch(/writeFile\(handle, SCRATCH\.planOptions, ''\)/);
  });

  it('a revised card follows the same rule', () => {
    // Feedback on a task list must not re-offer design alternatives either.
    const resend = ORCHESTRATOR.slice(ORCHESTRATOR.indexOf('private async resendApproval'));
    expect(resend.slice(0, 1200)).toMatch(/kind === 'plan' \|\| kind === 'design' \? await this\.planOptionsFor/);
  });
});
