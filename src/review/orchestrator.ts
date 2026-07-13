/**
 * ReviewOrchestrator — runs the self-review pipeline:
 *   1. static verification gate (deterministic lint/typecheck facts) — first
 *   2. N independent review rounds, in PARALLEL, each a fresh agent session
 *   3. semgrep in parallel (if configured)
 * It produces the per-round files + semgrep output; the MAIN agent then
 * consolidates them into pending_review.md.
 *
 * Lifted from upstream. Adaptation: a single configured agent runs all rounds
 * (corral is single-agent), so the agents[]×kinds filter is dropped; output
 * language/calibration come from the profile.
 */
import { SCRATCH, SCRATCH_DIR } from '../core/paths.js';
import { logger } from '../core/logger.js';
import type { AgentAdapter, AgentRunResult, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import type { ResolvedProfile } from '../profile/index.js';
import type { ReviewConfig } from '../config/schema.js';
import { reviewRoundPrompt, type ReviewTarget } from './prompt.js';
import { runSemgrep } from './semgrep-runner.js';
import { runStaticQa } from './static-qa-runner.js';

/** Called once per review round with its run result (for cost accounting). */
export type RoundCostFn = (result: AgentRunResult) => void;

export interface ReviewResult {
  roundFiles: string[];
  semgrepRan: boolean;
  staticQaRan: boolean;
  staticQaFailed: boolean;
}

export class ReviewOrchestrator {
  constructor(
    private readonly io: WorkspaceIO,
    private readonly agent: AgentAdapter,
    private readonly cfg: ReviewConfig,
    private readonly profile: ResolvedProfile,
    /** Per-turn timeout (ms) so a hung review round can't spin forever. */
    private readonly turnTimeoutMs?: number,
  ) {}

  async run(
    handle: WorkspaceHandle,
    issue: Issue,
    targets: ReviewTarget[],
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    verifyCommands: string[] = [],
    diffStats?: { lines: number; files: number },
    direction = '',
  ): Promise<ReviewResult> {
    const log = logger.child(issue.identifier);

    // Clear the previous cycle's round/semgrep files so a re-review can't leave a
    // stale higher-numbered round file behind to be folded into the consolidation.
    await this.io.exec(handle, `rm -f ${SCRATCH_DIR}/review_round_*.md ${SCRATCH.semgrep}`);

    // Static gate first so every parallel round can read its deterministic facts.
    const staticQa = await runStaticQa(this.io, handle, verifyCommands);

    // Fixed review depth: the same number of independent rounds for every issue.
    const rounds = this.cfg.rounds;
    log.info(`review rounds = ${rounds}${diffStats ? ` (diff: ${diffStats.lines} lines / ${diffStats.files} files)` : ''}`);

    const tasks: Array<Promise<string | null>> = [];
    for (let r = 1; r <= rounds; r++) {
      tasks.push(this.runRound(handle, issue, r, targets, model, referencePath, onRoundCost, direction));
    }

    const semgrepTask = this.cfg.semgrep
      ? runSemgrep(this.io, handle, this.cfg.semgrep)
      : Promise.resolve(false);

    const [roundResults, semgrepRan] = await Promise.all([Promise.all(tasks), semgrepTask]);
    const roundFiles = roundResults.filter((f): f is string => f !== null);
    log.info(`review complete: ${roundFiles.length} round file(s), semgrep=${semgrepRan}, static_qa=${staticQa.ran}`);
    return { roundFiles, semgrepRan, staticQaRan: staticQa.ran, staticQaFailed: staticQa.anyFailed };
  }

  private async runRound(
    handle: WorkspaceHandle,
    issue: Issue,
    round: number,
    targets: ReviewTarget[],
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    direction = '',
  ): Promise<string | null> {
    const log = logger.child(issue.identifier);
    try {
      const result = await this.agent.run(handle, issue, {
        stage: 'review',
        workflow: '', // self-contained; must not clobber the main workflow guide
        prompt: reviewRoundPrompt(issue, round, targets, this.profile, referencePath, direction),
        continueSession: false, // fresh, independent perspective
        model,
        turnTimeoutMs: this.turnTimeoutMs,
      });
      onRoundCost?.(result);
      if (!result.ok) {
        log.warn(`review round ${round} failed (${result.error ?? 'unknown'})`);
        return null;
      }
      return SCRATCH.reviewRound(round);
    } catch (err) {
      log.warn(`review round ${round} threw`, String(err));
      return null;
    }
  }
}
