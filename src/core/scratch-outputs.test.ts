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
import { SCRATCH } from './paths.js';
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

  it('every plan-writing turn declares pending_plan.md, and no other turn does', () => {
    // Kickoff draft, consolidation, the empty-output retry, answering a question, and the
    // review-feedback turn that may write a fix plan.
    expect(dispatchCalls().filter((c) => c.includes('SCRATCH.pendingPlan'))).toHaveLength(5);
  });
});
