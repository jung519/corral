/**
 * Two things are checked here, and the second is the one that matters.
 *
 * `wipeProduced` itself is four lines; the tests below pin its contract mostly so the empty
 * list stays a no-op rather than quietly becoming "wipe everything" again.
 *
 * The real guard is the last test. The bug in CRL-88 was never in the wiping function — it
 * was in *who called it with what*. The turns that read `pending_plan.md` and
 * `pending_review.md` blanked those files on the way in, and the failure was invisible
 * whenever one CLI session happened to span both turns. That is not something a reviewer
 * reliably catches, and there is no orchestrator test harness to catch it at runtime, so
 * the call sites are checked by reading the source — the same technique `boundaries.test.ts`
 * uses for the import wall.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCRATCH, SPEC, SPEC_DIR } from './paths.js';
import { wipeProduced } from './scratch-outputs.js';
import type { WorkspaceHandle, WorkspaceIO } from './types.js';

const handle = { id: 'ws', path: '/tmp/ws' } as unknown as WorkspaceHandle;

function recordingIo(): { io: WorkspaceIO; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const io = {
    async writeFile(_h: WorkspaceHandle, path: string, content: string) {
      writes.push([path, content]);
    },
  } as unknown as WorkspaceIO;
  return { io, writes };
}

describe('wipeProduced', () => {
  it('writes nothing when the turn declares no outputs', async () => {
    const { io, writes } = recordingIo();
    await wipeProduced(io, handle, []);
    expect(writes).toEqual([]);
  });

  it('blanks exactly the declared files and nothing else', async () => {
    const { io, writes } = recordingIo();
    await wipeProduced(io, handle, [SCRATCH.pendingPlan]);
    expect(writes).toEqual([[SCRATCH.pendingPlan, '']]);
  });

  it('blanks every declared file when a turn produces more than one', async () => {
    const { io, writes } = recordingIo();
    await wipeProduced(io, handle, [SCRATCH.pendingPlan, SCRATCH.pendingReview]);
    expect(writes.map(([path]) => path).sort()).toEqual([SCRATCH.pendingPlan, SCRATCH.pendingReview].sort());
    expect(writes.every(([, content]) => content === '')).toBe(true);
  });
});

const ORCHESTRATOR = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

/** Every `this.dispatch(...)` call, flattened onto one line. */
function dispatchCalls(): string[] {
  const flat = ORCHESTRATOR.replace(/\s+/g, ' ');
  return [...flat.matchAll(/this\.dispatch\((?:[^()]|\([^()]*\))*\)/g)].map((m) => m[0]);
}

describe('dispatch call sites', () => {
  it('finds the dispatches (guards against the regex silently matching nothing)', () => {
    expect(dispatchCalls().length).toBeGreaterThanOrEqual(10);
  });

  it('the turns that read a plan or review declare no outputs at all', () => {
    // WORKFLOW.md branch C reads pending_plan.md; the auto-fix turn reads pending_review.md;
    // a resumed run continues either. Each used to start with its own input blanked.
    const consumers = ['planApprovalPrompt', 'PROMPTS.applyReviewFixes', 'issue, resume,'];
    for (const consumer of consumers) {
      const call = dispatchCalls().find((c) => c.includes(consumer));
      expect(call, `no dispatch found for ${consumer}`).toBeDefined();
      expect(call, `${consumer} must not wipe anything`).not.toContain('SCRATCH.');
    }
  });

  it('only the review consolidation declares pending_review.md', () => {
    const declaring = dispatchCalls().filter((c) => c.includes('SCRATCH.pendingReview'));
    expect(declaring).toHaveLength(1);
    expect(declaring[0]).toContain("'review'");
  });

  /**
   * The spec documents are read across many turns — requirements by the design turn, both
   * by the task turn, all three by the implementation and the review. Declaring one as a
   * turn's output would blank the next turn's input, which is exactly the bug CRL-88 fixed
   * on `pending_plan.md`. They survive by being named nowhere, so that is what is pinned
   * here (CRL-101).
   */
  it('no dispatch declares a spec document as its output', () => {
    const offenders = dispatchCalls().filter(
      (call) => call.includes('SPEC.') || call.includes('.corral/spec/'),
    );
    expect(offenders).toEqual([]);
  });

  it('every plan-writing turn declares pending_plan.md, and no other turn does', () => {
    // Kickoff draft, consolidation, the empty-output retry, answering a question, and the
    // review-feedback turn that may write a fix plan.
    expect(dispatchCalls().filter((c) => c.includes('SCRATCH.pendingPlan'))).toHaveLength(5);
  });
});

describe('spec document paths', () => {
  it('live under their own directory, distinct from each other', () => {
    const paths = [SPEC.requirements, SPEC.design, SPEC.tasks];
    for (const p of paths) expect(p.startsWith(`${SPEC_DIR}/`)).toBe(true);
    expect(new Set(paths).size).toBe(3);
  });

  it('are not part of the scratch files a turn can be asked to clear', () => {
    // SCRATCH is what a dispatch may name in `produces`. Keeping the spec paths out of it
    // means the wipe list cannot reach them even by mistake.
    expect(Object.values(SCRATCH)).not.toContain(SPEC.requirements);
    expect(Object.values(SCRATCH)).not.toContain(SPEC.design);
    expect(Object.values(SCRATCH)).not.toContain(SPEC.tasks);
  });
});

/**
 * A restart during a human gate must be able to put the card back. That was already true
 * for the plan and the review; the spec gates could not do it because the paths did not
 * exist yet (CRL-102 left it here deliberately).
 */
describe('restart recovery', () => {
  it('knows which document backs each spec gate', () => {
    const table = ORCHESTRATOR.slice(
      ORCHESTRATOR.indexOf('recoverPendingApproval'),
      ORCHESTRATOR.indexOf('let s = spec[rt.phase]'),
    );
    for (const [phase, file, kind] of [
      ['requirements_sent', 'SPEC.requirements', "'requirements'"],
      ['design_sent', 'SPEC.design', "'design'"],
      ['tasks_sent', 'SPEC.tasks', "'tasks'"],
    ]) {
      const row = table.split('\n').find((l) => l.includes(`${phase}:`));
      expect(row, `${phase} missing from the recovery table`).toBeDefined();
      expect(row).toContain(file);
      expect(row).toContain(kind);
    }
  });
});
