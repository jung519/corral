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
  ) {}

  async run(
    handle: WorkspaceHandle,
    issue: Issue,
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    focus?: string,
  ): Promise<string[]> {
    const log = logger.child(issue.identifier);
    if (!this.cfg.enabled) return [];

    // Clear a previous cycle's critiques so a shorter run can't leave stale files.
    await this.io.exec(handle, `rm -f ${SCRATCH_DIR}/plan_critique_*.md`);

    const rounds = issue.labels.some((l) => this.cfg.heavy_labels.includes(l)) ? this.cfg.heavy_rounds : this.cfg.rounds;
    log.info(`plan critique rounds = ${rounds}${focus ? ` (focus: ${focus.slice(0, 40)})` : ''}`);

    const tasks: Array<Promise<string | null>> = [];
    for (let r = 1; r <= rounds; r++) {
      tasks.push(this.runRound(handle, issue, r, model, referencePath, onRoundCost, focus));
    }
    const results = await Promise.all(tasks);
    const files = results.filter((f): f is string => f !== null);
    log.info(`plan critique complete: ${files.length} file(s)`);
    return files;
  }

  private async runRound(
    handle: WorkspaceHandle,
    issue: Issue,
    round: number,
    model: string | undefined,
    referencePath?: string,
    onRoundCost?: RoundCostFn,
    focus?: string,
  ): Promise<string | null> {
    const log = logger.child(issue.identifier);
    try {
      const result = await this.agent.run(handle, issue, {
        stage: 'planning',
        workflow: '',
        prompt: planCritiquePrompt(issue, round, this.profile, referencePath, focus),
        continueSession: false,
        model,
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
