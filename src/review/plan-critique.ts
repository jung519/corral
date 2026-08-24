/**
 * PlanCritiqueOrchestrator — runs independent critic rounds over the DRAFT plan
 * (pending_plan.md) in PARALLEL, each a fresh session, mirroring the code-review
 * pipeline but for PLANNING. The main agent then consolidates the critiques into
 * the final vetted plan + options.
 *
 * Lifted from upstream. Adaptation: single configured agent runs all rounds
 * (agents[]×kinds filter dropped); language/conventions come from the profile.
 */
import { SCRATCH, SCRATCH_DIR } from '../core/paths.js';
import { logger } from '../core/logger.js';
import type { AgentAdapter, AgentRunResult, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import type { ResolvedProfile } from '../profile/index.js';
import type { PlanReviewConfig } from '../config/schema.js';
import { planCritiquePrompt } from './prompt.js';

export type RoundCostFn = (result: AgentRunResult) => void;

export class PlanCritiqueOrchestrator {
  constructor(
    private readonly io: WorkspaceIO,
    private readonly agent: AgentAdapter,
    private readonly cfg: PlanReviewConfig,
    private readonly profile: ResolvedProfile,
    /** Per-turn timeout (ms) so a hung critique round can't spin forever. */
    private readonly turnTimeoutMs?: number,
  ) {}

  async run(
    handle: WorkspaceHandle,
    issue: Issue,
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    focus?: string,
    direction = '',
    /**
     * True when picking up a cycle that a restart interrupted, rather than starting one.
     *
     * The distinction is the whole fix for CRL-87. Rounds that already produced a file are
     * finished work — a restart is not a reason to buy them again. It cost 1.97M input
     * tokens and $2.49 to re-run a round that had completed eight minutes earlier, and the
     * restart in question was the one made to RAISE the token limit that had blocked the
     * next step. Never set this for a human-requested re-vet: that is a new cycle and the
     * human is entitled to fresh critiques.
     */
    resume = false,
  ): Promise<string[]> {
    const log = logger.child(issue.identifier);
    if (!this.cfg.enabled) return [];

    const rounds = issue.labels.some((l) => this.cfg.heavy_labels.includes(l)) ? this.cfg.heavy_rounds : this.cfg.rounds;

    if (resume) {
      // The wipe below exists so a shortened run cannot leave a higher-numbered file behind
      // for consolidation to pick up. That risk survives a restart — the config may have
      // changed in between — so drop only what is out of range, never live output. Named
      // one by one rather than glob-expanded: `exec` is a shell whose dialect differs by
      // backend, and this list is short and known.
      const stale = await this.staleRounds(handle, rounds);
      if (stale.length > 0) {
        await this.io.exec(handle, `rm -f ${stale.join(' ')}`);
        log.info(`plan critique dropped out-of-range file(s): ${stale.join(', ')}`);
      }
    } else {
      // Clear a previous cycle's critiques so a shorter run can't leave stale files.
      await this.io.exec(handle, `rm -f ${SCRATCH_DIR}/plan_critique_*.md`);
    }

    const done = resume ? await this.completedRounds(handle, rounds) : new Set<number>();
    const todo = Array.from({ length: rounds }, (_, i) => i + 1).filter((r) => !done.has(r));

    if (done.size > 0) {
      // Silent reuse and silent re-running look identical from the outside, and the whole
      // complaint here was about an expensive step happening again unannounced.
      log.info(`plan critique reusing round(s) ${[...done].join(', ')} from the interrupted run`);
    }
    if (todo.length === 0) {
      log.info(`plan critique complete: ${done.size} file(s) — all rounds already present, nothing re-run`);
      return [...done].sort((a, b) => a - b).map((r) => SCRATCH.planCritique(r));
    }
    log.info(`plan critique rounds = ${rounds}${done.size ? ` (running ${todo.join(', ')})` : ''}${focus ? ` (focus: ${focus.slice(0, 40)})` : ''}`);

    const results = await Promise.all(
      todo.map((r) => this.runRound(handle, issue, r, model, referencePath, onRoundCost, focus, direction)),
    );
    const files = [...[...done].map((r) => SCRATCH.planCritique(r)), ...results.filter((f): f is string => f !== null)];
    log.info(`plan critique complete: ${files.length} file(s)`);
    return files;
  }

  /** Critique files whose round number is past the count this run will produce. */
  private async staleRounds(handle: WorkspaceHandle, rounds: number): Promise<string[]> {
    const names = await this.io.list(handle, SCRATCH_DIR);
    return names
      .map((n) => ({ n, m: /^plan_critique_(\d+)\.md$/.exec(n) }))
      .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null && Number(x.m[1]) > rounds)
      .map((x) => `${SCRATCH_DIR}/${x.n}`);
  }

  /**
   * Rounds whose critique file is present AND has content.
   *
   * Presence alone is not enough: the agent writes the file itself, so a core killed while
   * a round was mid-write leaves a zero-byte file, and treating that as finished would feed
   * an empty critique into consolidation. A file truncated part-way through is still
   * indistinguishable from a complete one — there is no way to judge that from the outside.
   */
  private async completedRounds(handle: WorkspaceHandle, rounds: number): Promise<Set<number>> {
    const done = new Set<number>();
    for (let r = 1; r <= rounds; r++) {
      const content = await this.io.readFile(handle, SCRATCH.planCritique(r)).catch(() => null);
      if (content && content.trim()) done.add(r);
    }
    return done;
  }

  private async runRound(
    handle: WorkspaceHandle,
    issue: Issue,
    round: number,
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    focus?: string,
    direction = '',
  ): Promise<string | null> {
    const log = logger.child(issue.identifier);
    try {
      const result = await this.agent.run(handle, issue, {
        stage: 'planning',
        workflow: '',
        prompt: planCritiquePrompt(issue, round, this.profile, referencePath, focus, direction),
        continueSession: false,
        model,
        turnTimeoutMs: this.turnTimeoutMs,
      });
      onRoundCost?.(result);
      if (!result.ok) {
        log.warn(`plan critique round ${round} failed (${result.error ?? 'unknown'})`);
        return null;
      }
      return SCRATCH.planCritique(round);
    } catch (err) {
      log.warn(`plan critique round ${round} threw`, String(err));
      return null;
    }
  }
}
