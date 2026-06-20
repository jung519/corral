/**
 * Orchestrator — the core. Owns the dispatch loop, phase machine, and all
 * side-effects (tracker transitions, notifications, cleanup). The agent is an
 * unattended worker that only writes `.corral/` files; the orchestrator reads them
 * after each run and decides the next step.
 *
 * Happy path:
 *   new issue → plan(A) → [✅] → implement(C) → self-review → consolidate(D)
 *   → [✅] → PR(F) → PR comments(G) → [✅] → fix(H) → merge → done + cleanup
 * Human touch-points: plan approval, review approval, PR-fix-plan approval.
 *
 * Lifted from upstream. Adaptations: single configured agent (not agents[]×kinds);
 * repositories via RepositoryRouter; review/plan-review/concurrency from the
 * corral config; signals + phrasing via the profile; UI/status strings in English
 * (the agent's OUTPUT language is controlled by the profile, not these labels);
 * scratch files via core/paths (SCRATCH); BYOK (no ~/.claude). A live cycle needs a
 * real channel (the dashboard lands in S3).
 */
import { processAttachments } from './attachments.js';
import { buildSignals, kickoffPrompt, PROMPTS, renderWorkflow, type Signals } from './agent/prompt-builder.js';
import type { Config } from './config/schema.js';
import { ConcurrencyLimiter } from './core/concurrency-limiter.js';
import { CostTracker } from './core/cost-tracker.js';
import { bus } from './core/events.js';
import { IssueStateStore, type IssueRuntime } from './core/issue-state.js';
import { logger } from './core/logger.js';
import { SCRATCH } from './core/paths.js';
import {
  type AgentAdapter,
  type AgentRunResult,
  type AgentStage,
  type ChannelAdapter,
  type Issue,
  type PullRequest,
  RESUMABLE_PHASES,
  type RepositoryAdapter,
  type TrackerAdapter,
  type WorkspaceAdapter,
  type WorkspaceHandle,
} from './core/types.js';
import type { ApprovalDetail } from './core/types.js';
import type { ResolvedProfile } from './profile/index.js';
import type { RepositoryRouter } from './repository/router.js';
import { PlanCritiqueOrchestrator } from './review/plan-critique.js';
import { ReviewOrchestrator } from './review/orchestrator.js';

export class Orchestrator {
  private readonly review: ReviewOrchestrator;
  private readonly planCritique: PlanCritiqueOrchestrator;
  private readonly cost = new CostTracker();
  private readonly limiter: ConcurrencyLimiter;
  private readonly store = new IssueStateStore();
  private readonly signals: Signals;
  private readonly handles = new Map<string, WorkspaceHandle>();
  private readonly busy = new Set<string>();
  /** Per-issue serialization: events for one issue run one-at-a-time, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly tracker: TrackerAdapter,
    private readonly router: RepositoryRouter,
    private readonly workspace: WorkspaceAdapter,
    private readonly agent: AgentAdapter,
    private readonly channel: ChannelAdapter,
    private readonly profile: ResolvedProfile,
  ) {
    this.review = new ReviewOrchestrator(workspace.io, agent, config.review, profile);
    this.planCritique = new PlanCritiqueOrchestrator(workspace.io, agent, config.plan_review, profile);
    this.limiter = new ConcurrencyLimiter(config.max_active_issues);
    this.signals = buildSignals(profile.t);

    this.channel.onApprove((id, detail) => this.handleApprove(id, detail));
    this.channel.onFeedback((id, text) => this.handleFeedback(id, text));
  }

  // ───────────────────────────────────────────────────────── lifecycle
  // No polling: the control plane (dashboard) drives progression. start() only
  // recovers in-flight issues; new work begins via startIssue().

  async start(): Promise<void> {
    await this.recover();
    logger.info('orchestrator started (control-plane-driven, no polling)');
  }

  stop(): void {
    this.stopped = true;
  }

  readonly trackerKind = (): string => this.tracker.kind;

  /** Cross-check persisted state with live workspaces; seed the limiter. */
  private async recover(): Promise<void> {
    const active: string[] = [];
    for (const rt of this.store.all()) {
      const handle = await this.workspace.reattach(rt.identifier);
      if (handle) {
        this.handles.set(rt.identifier, handle);
        active.push(rt.identifier);
        if (!rt.title) {
          const issue = await this.tracker.fetchIssueByIdentifier(rt.identifier).catch(() => null);
          if (issue) {
            rt.title = issue.title;
            rt.url = issue.url;
            this.store.upsert(rt);
          }
        }
        await this.recoverPendingApproval(rt, handle);
        if (rt.phase === 'plan_reviewing') await this.resumeVetting(rt, handle);
        else if (RESUMABLE_PHASES.has(rt.phase)) await this.markResumable(rt);
        bus.emitEvent({ identifier: rt.identifier, kind: 'notice', phase: rt.phase, label: `↻ Recovered (phase=${rt.phase})` });
        logger.child(rt.identifier).info(`recovered (phase=${rt.phase})`);
      } else if (rt.phase !== 'pr_open') {
        logger.child(rt.identifier).warn('workspace missing on recovery; dropping state');
        this.store.delete(rt.identifier);
      } else {
        active.push(rt.identifier); // PR open: still tracked for comments/merge
      }
    }
    this.limiter.seed(active);
  }

  /** Re-create a lost pending approval from the workspace's `.corral/` file. */
  private async recoverPendingApproval(rt: IssueRuntime, handle: WorkspaceHandle): Promise<void> {
    const spec: Record<string, { file: string; kind: 'plan' | 'pr_plan' | 'review' | 'fix_plan' }> = {
      plan_sent: { file: SCRATCH.pendingPlan, kind: 'plan' },
      pr_plan_sent: { file: SCRATCH.pendingPlan, kind: 'pr_plan' },
      review_sent: { file: SCRATCH.pendingReview, kind: 'review' },
    };
    let s = spec[rt.phase];
    if (!s) return;
    let body = await this.readOutput(handle, s.file);
    if (!body && rt.phase === 'review_sent') {
      const plan = await this.readOutput(handle, SCRATCH.pendingPlan);
      if (plan) {
        body = plan;
        s = { file: SCRATCH.pendingPlan, kind: 'fix_plan' };
        rt.phase = 'plan_sent';
        logger.child(rt.identifier).info('recovered fix-plan (review_sent had empty review)');
      }
    }
    if (!body) return;
    const issue = await this.tracker.fetchIssueByIdentifier(rt.identifier).catch(() => null);
    const approvalId = await this.channel.sendApproval({
      identifier: rt.identifier,
      kind: s.kind,
      title: rt.title ?? issue?.title ?? rt.identifier,
      body,
      options: s.kind === 'plan' ? await this.planOptionsFor(handle) : undefined,
    });
    rt.approvalId = approvalId;
    this.store.upsert(rt);
    logger.child(rt.identifier).info(`recovered pending approval (${rt.phase})`);
  }

  /** Flag an unattended phase left mid-run by a restart as retryable. */
  private async markResumable(rt: IssueRuntime): Promise<void> {
    rt.stuck = true;
    this.store.upsert(rt);
    const label = `🔄 Resumable — phase '${rt.phase}' was interrupted by a restart`;
    bus.emitEvent({ identifier: rt.identifier, kind: 'notice', phase: rt.phase, label });
    await this.channel
      .notify(rt.identifier, `🔄 Phase '${rt.phase}' was interrupted by a restart. Press "Retry" to resume.`)
      .catch(() => {});
    logger.child(rt.identifier).warn(`resumable after restart (phase=${rt.phase}) — awaiting retry`);
  }

  // ──────────────────────────────────────── commands (on-demand, no polling)

  /** Candidate issues from the tracker that are not already in flight. */
  async listCandidates(): Promise<
    Array<{ identifier: string; title: string; state: string; repoKey?: string; inFlight: boolean }>
  > {
    const issues = await this.tracker.fetchCandidateIssues();
    return issues.map((i) => ({
      identifier: i.identifier,
      title: i.title,
      state: i.state,
      repoKey: i.repoKey,
      inFlight: this.store.get(i.identifier) !== undefined,
    }));
  }

  /** Begin work on an issue. Creates the workspace synchronously so failures surface immediately. */
  async startIssue(identifier: string): Promise<{ ok: boolean; message?: string }> {
    if (this.store.get(identifier)) return { ok: false, message: 'Already in progress.' };
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return { ok: false, message: 'Issue not found.' };
    if (!this.limiter.tryAcquire(identifier)) return { ok: false, message: 'Concurrency limit reached.' };

    const repo = this.router.resolve(issue);
    let handle;
    try {
      logger.child(identifier).info('creating workspace');
      handle = await this.workspace.create({
        identifier,
        cloneUrl: repo.cloneUrl(),
        baseBranch: repo.baseBranchFor(issue),
        image: repo.workerImage,
      });
    } catch (err) {
      this.limiter.release(identifier);
      logger.child(identifier).error('workspace create failed', String(err));
      return { ok: false, message: `Workspace creation failed: ${oneLineErr(err)}` };
    }
    this.handles.set(identifier, handle);

    const rt: IssueRuntime = { identifier, repoKey: repo.key, phase: 'initial', title: issue.title, url: issue.url };
    this.store.upsert(rt);
    bus.emitEvent({ identifier, kind: 'phase', phase: 'planning', label: `📋 Planning started — ${issue.title}` });

    void this.serialize(identifier, async () => {
      if (repo.afterClone) {
        bus.emitEvent({ identifier, kind: 'notice', label: `📦 Installing dependencies — ${repo.afterClone}` });
        const res = await this.workspace.io.exec(handle, repo.afterClone);
        if (res.code !== 0) {
          bus.emitEvent({
            identifier,
            kind: 'notice',
            label: `⚠️ Dependency install failed (${repo.afterClone}, code ${res.code}) — static gate/build may break`,
          });
          logger.child(identifier).warn('after_clone failed', res.stderr.slice(-400));
        }
      }
      try {
        await processAttachments(this.workspace.io, handle, issue);
      } catch (err) {
        bus.emitEvent({ identifier, kind: 'notice', label: `⚠️ Attachment processing error: ${oneLineErr(err)}` });
      }
      return this.dispatchPlanning(rt, issue).catch((err) => {
        logger.child(identifier).error('planning failed', String(err));
        bus.emitEvent({ identifier, kind: 'error', label: `❌ Planning failed: ${oneLineErr(err)}` });
      });
    });
    return { ok: true };
  }

  /** Re-run the current human-waiting step for a stuck issue. Reuses the workspace + session. */
  async retry(identifier: string): Promise<{ ok: boolean; message?: string }> {
    const rt = this.store.get(identifier);
    if (!rt) return { ok: false, message: 'Not an in-flight issue.' };
    if (this.busy.has(identifier)) return { ok: false, message: 'Busy — try again shortly.' };
    const handle = this.handles.get(identifier);
    if (!handle) return { ok: false, message: 'No workspace — restart the issue from scratch.' };
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return { ok: false, message: 'Issue not found.' };

    bus.emitEvent({ identifier, kind: 'notice', label: `🔄 Retry — re-running phase '${rt.phase}'` });
    void this.serialize(identifier, () =>
      this.redispatchPhase(rt, issue).catch((err) => {
        logger.child(identifier).error('retry failed', String(err));
        bus.emitEvent({ identifier, kind: 'error', label: `❌ Retry failed: ${oneLineErr(err)}` });
      }),
    );
    return { ok: true };
  }

  /** Re-run the step that produces the current phase's awaited output. */
  private async redispatchPhase(rt: IssueRuntime, issue: Issue): Promise<void> {
    switch (rt.phase) {
      case 'review_sent':
        await this.reviewApproved(rt, issue);
        return;
      case 'plan_sent':
      case 'pr_plan_sent': {
        const kind = rt.phase === 'plan_sent' ? 'plan' : 'pr_plan';
        const msg = 'The previous output was empty. Re-write the plan to `.corral/pending_plan.md` and stop.';
        const result = await this.dispatch(rt, issue, msg, true, 'planning');
        if (result.ok) await this.afterPlanProduced(rt, issue, kind);
        return;
      }
      case 'implementing':
      case 'review_fixing':
        await this.resumeImplementing(rt, issue);
        return;
      default:
        await this.surfaceStuck(rt, `Phase '${rt.phase}' does not support auto-retry — restart the issue from scratch.`);
    }
  }

  /** Finish the issue (done + cost + cleanup). Verifies the PR is merged first unless forced. */
  async completeByUser(identifier: string, force = false): Promise<{ ok: boolean; merged?: boolean; message?: string }> {
    const rt = this.store.get(identifier);
    if (!rt) return { ok: false, message: 'Not tracked.' };

    if (!force && rt.pr) {
      const repo = this.router.byKey(rt.repoKey);
      const pr = repo ? await repo.refreshPullRequest(rt.pr.number).catch(() => null) : null;
      if (!pr?.merged) {
        return { ok: false, merged: false, message: `PR #${rt.pr.number} is not merged yet.` };
      }
    }
    await this.serialize(identifier, () => this.completeIssue(identifier));
    return { ok: true };
  }

  // ─────────────────────────────────────────────────── planning (Branch A)

  /** Reference repo path inside the workspace for the agent to consult (none for now). */
  private referencePath(): string | undefined {
    // TODO: clone profile.referenceRepo read-only and return its workspace path.
    return undefined;
  }

  private async dispatchPlanning(rt: IssueRuntime, issue: Issue): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const draft = await this.dispatch(rt, issue, kickoffPrompt(issue), false, 'planning');
    if (!draft.ok) return;
    if (await this.handleQuestion(rt, handle)) return;
    if (!(await this.readOutput(handle, SCRATCH.pendingPlan))) {
      await this.surfaceStuck(rt, 'Plan draft (.corral/pending_plan.md) is empty — please retry.');
      return;
    }
    await this.vetAndSendPlan(rt, issue, handle);
  }

  /** Plan vetting: critics over the draft → consolidate → send approval card. */
  private async vetAndSendPlan(rt: IssueRuntime, issue: Issue, handle: WorkspaceHandle, focus?: string): Promise<void> {
    rt.phase = 'plan_reviewing';
    this.store.upsert(rt);
    bus.emitEvent({
      identifier: rt.identifier,
      kind: 'phase',
      phase: 'plan_reviewing',
      label: focus ? `🔍 Re-vetting plan — ${focus.slice(0, 40)}` : '🔍 Vetting plan',
    });
    await this.planCritique.run(
      handle,
      issue,
      this.planningModel(),
      this.referencePath(),
      (r) => this.cost.add(rt.identifier, r),
      focus,
    );
    // Preserve the draft before the consolidate dispatch's wipeOutputs clears it.
    await this.workspace.io.exec(handle, `cp ${SCRATCH.pendingPlan} ${SCRATCH.planDraft} 2>/dev/null || true`);
    const consolidate = await this.dispatch(rt, issue, PROMPTS.consolidatePlan, true, 'planning');
    if (!consolidate.ok) return;
    await this.afterPlanProduced(rt, issue, 'plan');
  }

  /** Resume plan vetting interrupted by a restart (phase stuck at plan_reviewing). */
  private async resumeVetting(rt: IssueRuntime, handle: WorkspaceHandle): Promise<void> {
    const issue = await this.tracker.fetchIssueByIdentifier(rt.identifier).catch(() => null);
    if (!issue) return;
    await this.workspace.io.exec(
      handle,
      `test -s ${SCRATCH.pendingPlan} || cp ${SCRATCH.planDraft} ${SCRATCH.pendingPlan} 2>/dev/null || true`,
    );
    if (!(await this.readOutput(handle, SCRATCH.pendingPlan))) {
      await this.surfaceStuck(rt, 'Failed to resume plan vetting — no draft left. Restart the issue.');
      return;
    }
    bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: '↻ Auto-resuming interrupted plan vetting' });
    void this.serialize(rt.identifier, () =>
      this.vetAndSendPlan(rt, issue, handle).catch((err) => {
        logger.child(rt.identifier).error('resumeVetting failed', String(err));
        bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: `❌ Plan vetting resume failed: ${oneLineErr(err)}` });
      }),
    );
  }

  /** Human "review further" — re-vet the plan with a specific concern. */
  async refinePlan(identifier: string, focus: string): Promise<{ ok: boolean; message?: string }> {
    const rt = this.store.get(identifier);
    if (!rt) return { ok: false, message: 'Not an in-flight issue.' };
    if (rt.phase !== 'plan_sent') return { ok: false, message: 'Not in the plan-review phase.' };
    if (!focus.trim()) return { ok: false, message: 'Please enter what needs more review.' };
    if (this.busy.has(identifier)) return { ok: false, message: 'Busy.' };
    const handle = this.handles.get(identifier);
    if (!handle) return { ok: false, message: 'No workspace — restart from scratch.' };
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return { ok: false, message: 'Issue not found.' };
    this.clearApproval(rt);
    void this.serialize(identifier, () =>
      this.vetAndSendPlan(rt, issue, handle, focus.trim()).catch((err) => {
        logger.child(identifier).error('refinePlan failed', String(err));
        bus.emitEvent({ identifier, kind: 'error', label: `❌ Re-vetting failed: ${oneLineErr(err)}` });
      }),
    );
    return { ok: true };
  }

  // ───────────────────────────────────────────────────── dispatch helper

  private async dispatch(
    rt: IssueRuntime,
    issue: Issue,
    prompt: string,
    continueSession: boolean,
    stage: AgentStage,
  ): Promise<AgentRunResult> {
    const handle = this.handles.get(rt.identifier);
    if (!handle) throw new Error(`no workspace handle for ${rt.identifier}`);
    const repo = this.router.resolve(issue);

    if (this.busy.has(rt.identifier)) {
      logger.child(rt.identifier).warn('dispatch requested while busy; skipping');
      return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'crashed' };
    }
    this.busy.add(rt.identifier);
    try {
      const workflow = await renderWorkflow({
        issue,
        tracker_kind: this.tracker.kind,
        repo: repo.key,
        base_branch: repo.baseBranchFor(issue),
        branch: repo.branchNameFor(issue),
        reference_path: this.referencePath(),
      });
      await this.wipeOutputs(handle);
      const result = await this.agent.run(handle, issue, { stage, workflow, prompt, continueSession });
      this.cost.add(rt.identifier, result);
      if (result.error === 'auth') {
        rt.phase = 'auth_error_waiting';
        this.store.upsert(rt);
        await this.channel.notify(
          rt.identifier,
          'Agent authentication appears to have expired. Re-authenticate on the host, then let us know.',
        );
      }
      return result;
    } finally {
      this.busy.delete(rt.identifier);
    }
  }

  // ──────────────────────────────────── read agent outputs → next step

  /** Adaptive plan option labels from plan_options.json (recommended first). 0~1 → no selection UI. */
  private async planOptionsFor(handle: WorkspaceHandle): Promise<string[] | undefined> {
    const raw = await this.workspace.io.readFile(handle, SCRATCH.planOptions);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 1) return parsed.map((o) => String(o)).slice(0, 5);
    } catch {
      /* malformed → single recommended plan */
    }
    return undefined;
  }

  private async afterPlanProduced(rt: IssueRuntime, issue: Issue, kind: 'plan' | 'pr_plan' | 'fix_plan'): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    if (await this.handleQuestion(rt, handle)) return;

    const plan = await this.readOutput(handle, SCRATCH.pendingPlan);
    if (!plan) {
      await this.surfaceStuck(
        rt,
        'Plan file (.corral/pending_plan.md) is empty — the agent did not write a plan. Please retry.',
      );
      return;
    }
    const options = kind === 'plan' ? await this.planOptionsFor(handle) : undefined;
    const approvalId = await this.channel.sendApproval({ identifier: rt.identifier, kind, title: issue.title, body: plan, options });
    rt.approvalId = approvalId;
    rt.phase = kind === 'pr_plan' ? 'pr_plan_sent' : 'plan_sent';
    this.store.upsert(rt);
    const label = kind === 'fix_plan' ? '🔔 Action needed — review the fix plan' : '🔔 Action needed — review the plan';
    bus.emitEvent({ identifier: rt.identifier, kind: 'approval', phase: rt.phase, label });
    if (kind === 'plan') await this.logPlanToTracker(rt, issue, plan);
  }

  /** Record the vetted plan as a tracker comment (history) — non-fatal. */
  private async logPlanToTracker(rt: IssueRuntime, issue: Issue, plan: string): Promise<void> {
    const body = `## 🧭 Corral plan (vetted direction)\n\n_Draft → independent critique. Approve/feedback in the dashboard._\n\n${plan}`;
    try {
      await this.tracker.createComment(issue, body);
      bus.emitEvent({ identifier: rt.identifier, kind: 'activity', label: '📝 Logged plan to tracker' });
    } catch (err) {
      logger.child(rt.identifier).warn('failed to log plan to tracker', String(err));
      bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: '⚠️ Failed to log plan to tracker (dashboard review unaffected)' });
    }
  }

  private async handleQuestion(rt: IssueRuntime, handle: WorkspaceHandle): Promise<boolean> {
    const q = await this.readOutput(handle, SCRATCH.question);
    if (!q) return false;
    const approvalId = await this.channel.sendApproval({ identifier: rt.identifier, kind: 'question', title: 'Agent question', body: q });
    rt.approvalId = approvalId;
    rt.phase = 'question_sent';
    this.store.upsert(rt);
    await this.workspace.io.writeFile(handle, SCRATCH.question, '');
    return true;
  }

  // ──────────────────────────────────────────────── approval handling

  /** Run `fn` after any in-flight handler for the same issue finishes (per-issue serialization). */
  private serialize(identifier: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(identifier) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(identifier, run.catch(() => {}));
    return run;
  }

  private handleApprove(approvalId: string, detail?: ApprovalDetail): void {
    const rt = this.store.findByApprovalId(approvalId);
    if (!rt) return;
    void this.serialize(rt.identifier, () => this.onApprove(rt.identifier, approvalId, detail));
  }

  private async onApprove(identifier: string, approvalId: string, detail?: ApprovalDetail): Promise<void> {
    const rt = this.store.get(identifier);
    if (!rt || rt.approvalId !== approvalId) return;
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return;
    this.clearApproval(rt);

    const ack: Record<string, string> = {
      plan_sent: '✅ Plan approved — starting implementation.',
      pr_plan_sent: '✅ Fix plan approved — starting PR fixes.',
      review_sent: '✅ Review approved — preparing the PR.',
    };
    if (ack[rt.phase]) await this.channel.notify(identifier, ack[rt.phase]!);
    bus.emitEvent({ identifier, kind: 'approval', phase: rt.phase, label: '✅ Approved' });

    switch (rt.phase) {
      case 'plan_sent':
        await this.implementAndReview(rt, issue, detail);
        break;
      case 'pr_plan_sent':
        await this.implementFix(rt, issue);
        break;
      case 'review_sent':
        await this.reviewApproved(rt, issue);
        break;
      default:
        logger.child(identifier).warn(`approve ignored in phase ${rt.phase}`);
    }
  }

  /** Branch C approval prompt, incorporating the selected plan option + notes. */
  private planApprovalPrompt(detail?: ApprovalDetail): string {
    if (!detail?.selection && !detail?.notes) return this.signals.approve;
    const parts = [this.signals.approve];
    if (detail.selection) parts.push(`Implement the "${detail.selection}" option.`);
    if (detail.notes) parts.push(`Additional instructions: ${detail.notes}`);
    return parts.join(' ');
  }

  private handleFeedback(approvalId: string, text: string): void {
    const rt = this.store.findByApprovalId(approvalId);
    if (!rt) return;
    void this.serialize(rt.identifier, () => this.onFeedback(rt.identifier, approvalId, text));
  }

  private async onFeedback(identifier: string, approvalId: string, text: string): Promise<void> {
    const rt = this.store.get(identifier);
    if (!rt || rt.approvalId !== approvalId) return;
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return;

    await this.channel.notify(identifier, "⚠️ Feedback received — I'll revise and resend.");

    if (rt.phase === 'question_sent') {
      this.clearApproval(rt);
      const result = await this.dispatch(rt, issue, text, true, 'planning');
      if (result.ok) await this.afterPlanProduced(rt, issue, 'plan');
      return;
    }

    const signal = this.signals.feedback(text);
    if (rt.phase === 'plan_sent' || rt.phase === 'pr_plan_sent') {
      const result = await this.dispatch(rt, issue, signal, true, 'planning');
      if (result.ok) await this.resendApproval(rt, issue, rt.phase === 'plan_sent' ? 'plan' : 'pr_plan', SCRATCH.pendingPlan);
    } else if (rt.phase === 'review_sent') {
      const result = await this.dispatch(rt, issue, signal, true, 'planning');
      if (!result.ok) return;
      const handle = this.handles.get(identifier)!;
      if (await this.readOutput(handle, SCRATCH.pendingPlan)) {
        await this.afterPlanProduced(rt, issue, 'fix_plan');
      } else {
        await this.resendApproval(rt, issue, 'review', SCRATCH.pendingReview);
      }
    } else {
      logger.child(rt.identifier).warn(`feedback ignored in phase ${rt.phase}`);
    }
  }

  // ───────────────────────────────────────── implement → self-review

  private async implementAndReview(rt: IssueRuntime, issue: Issue, detail?: ApprovalDetail): Promise<void> {
    rt.phase = 'implementing';
    rt.stuck = false;
    this.store.upsert(rt);
    const sel = detail?.selection ? ` (${detail.selection})` : '';
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'implementing', label: `🛠 Implementing${sel}` });
    await this.tracker.transitionIssue(issue, 'in_progress');

    const impl = await this.dispatch(rt, issue, this.planApprovalPrompt(detail), true, 'implementation');
    if (!impl.ok) return;
    await this.reviewAfterImplement(rt, issue);
  }

  /** Resume an implement / review-fix run that a restart interrupted (continue the session). */
  private async resumeImplementing(rt: IssueRuntime, issue: Issue): Promise<void> {
    rt.phase = 'implementing';
    rt.stuck = false;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'implementing', label: '🛠 Resuming implementation (interrupted run)' });
    await this.tracker.transitionIssue(issue, 'in_progress').catch(() => {});

    const impl = await this.dispatch(rt, issue, this.signals.resume, true, 'implementation');
    if (!impl.ok) {
      await this.surfaceStuck(
        rt,
        'Could not resume the implementation session (no session memory, or the agent stopped). Restart the issue from scratch.',
      );
      return;
    }
    await this.reviewAfterImplement(rt, issue);
  }

  /** Post-implementation tail: question → diff guard → self-review loop → PR / review card. */
  private async reviewAfterImplement(rt: IssueRuntime, issue: Issue): Promise<void> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;

    if (await this.handleQuestion(rt, handle)) return;

    const base = (await this.readOutput(handle, SCRATCH.baseCommit))?.trim();
    if (!base) {
      await this.surfaceStuck(rt, 'No base_commit.txt after implementation — cannot scope the review diff. Please retry.');
      return;
    }
    rt.baseCommit = base;
    this.store.upsert(rt);

    const diff = await this.workspace.io.getDiff(handle, base);
    if (!diff.trim()) {
      log.error('workspace diff is empty after implementation — no changes committed here');
      await this.channel.notify(
        rt.identifier,
        '❌ No changes in the workspace. The agent did not commit to this repo (check repo config/isolation). Aborting.',
      );
      bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: '❌ No changes — aborted (empty workspace diff)' });
      return;
    }

    const review = await this.selfReviewLoop(rt, issue, handle, base);
    if (!review) {
      log.warn('self-review produced no review');
      await this.surfaceStuck(rt, 'Self-review produced no result — please retry the review.', true);
      return;
    }
    const status = await this.reviewStatus(handle);
    const clean = !status || status.blocker + status.suggestion === 0;
    if (clean && this.config.review.auto_pr_when_clean) {
      bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: '✅ Self-review clean — opening PR automatically' });
      await this.reviewApproved(rt, issue);
      return;
    }
    const approvalId = await this.channel.sendApproval({ identifier: rt.identifier, kind: 'review', title: issue.title, body: review });
    rt.approvalId = approvalId;
    rt.phase = 'review_sent';
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'approval', phase: 'review_sent', label: '🔔 Action needed — review (fixes auto-applied)' });
  }

  /** Self-review with an auto-fix loop. Returns the final review (fixes applied), or null. */
  private async selfReviewLoop(rt: IssueRuntime, issue: Issue, handle: WorkspaceHandle, base: string): Promise<string | null> {
    const log = logger.child(rt.identifier);
    const reviewRepo = this.router.resolve(issue);
    const maxFixRounds = this.config.review.max_fix_rounds;
    for (let round = 0; ; round++) {
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'phase',
        phase: 'reviewing',
        label: round === 0 ? '🔍 Self-reviewing' : `🔍 Re-reviewing (after ${round} auto-fix round(s))`,
      });
      const diff = await this.workspace.io.getDiff(handle, base);
      const diffStats = { lines: 0, files: 0 };
      for (const l of diff.split('\n')) {
        if (l.startsWith('diff --git ')) diffStats.files++;
        else if ((l[0] === '+' && !l.startsWith('+++')) || (l[0] === '-' && !l.startsWith('---'))) diffStats.lines++;
      }
      await this.review.run(
        handle,
        issue,
        base,
        this.reviewModel(),
        this.referencePath(),
        (r) => this.cost.add(rt.identifier, r),
        reviewRepo.verifyCommands,
        diffStats,
      );
      await this.uploadDiff(rt, issue, base);
      const consolidate = await this.dispatch(rt, issue, PROMPTS.consolidateReview, true, 'planning');
      if (!consolidate.ok) return null;
      const review = await this.readOutput(handle, SCRATCH.pendingReview);
      if (!review) {
        log.warn('no pending_review.md after consolidation');
        return null;
      }
      await this.workspace.io.writeFile(handle, SCRATCH.prevReview, review);

      const status = await this.reviewStatus(handle);
      const fixable = status ? status.blocker + status.suggestion : 0;
      if (fixable === 0 || round >= maxFixRounds) {
        if (fixable > 0) {
          bus.emitEvent({
            identifier: rt.identifier,
            kind: 'notice',
            label: `⚠️ ${fixable} finding(s) remain after ${maxFixRounds} auto-fix round(s) — handing to human review`,
          });
        }
        return review;
      }

      rt.phase = 'review_fixing';
      this.store.upsert(rt);
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'phase',
        phase: 'review_fixing',
        label: `🔧 Auto-fixing review findings (BLOCKER ${status?.blocker ?? 0}, SUG ${status?.suggestion ?? 0})`,
      });
      const fix = await this.dispatch(rt, issue, PROMPTS.applyReviewFixes, true, 'implementation');
      if (!fix.ok) return null;
    }
  }

  private async reviewStatus(handle: WorkspaceHandle): Promise<{ blocker: number; suggestion: number; nit: number } | null> {
    const raw = await this.workspace.io.readFile(handle, SCRATCH.reviewStatus);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Record<string, unknown>;
      return { blocker: Number(p.blocker) || 0, suggestion: Number(p.suggestion) || 0, nit: Number(p.nit) || 0 };
    } catch {
      return null;
    }
  }

  private async reviewApproved(rt: IssueRuntime, issue: Issue): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const result = await this.dispatch(rt, issue, this.signals.approve, true, 'implementation');
    if (!result.ok) return;

    const meta = await this.readJson(handle, SCRATCH.prMeta);
    if (meta && typeof meta.title === 'string') {
      await this.pushAndCreatePr(rt, issue, meta);
      return;
    }
    const plan = await this.readOutput(handle, SCRATCH.pendingPlan);
    if (plan) {
      await this.afterPlanProduced(rt, issue, 'fix_plan');
    } else {
      await this.surfaceStuck(
        rt,
        'After review approval, neither a fix plan (.corral/pending_plan.md) nor PR metadata was produced. If there were BLOCKERs a fix plan should appear — check the agent output and retry.',
      );
    }
  }

  private async implementFix(rt: IssueRuntime, issue: Issue): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const result = await this.dispatch(rt, issue, this.signals.approve, true, 'implementation');
    if (!result.ok) return;
    const meta = await this.readJson(handle, SCRATCH.prMeta);
    if (meta && typeof meta.title === 'string') await this.pushAndCreatePr(rt, issue, meta);
  }

  /** Orchestrator-owned push + PR creation (push via the workspace, PR via the adapter). */
  private async pushAndCreatePr(rt: IssueRuntime, issue: Issue, meta: Record<string, unknown>): Promise<void> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;
    const repo = this.router.resolve(issue);
    const branch = repo.branchNameFor(issue);
    const base = repo.baseBranchFor(issue);

    bus.emitEvent({ identifier: rt.identifier, kind: 'activity', label: `🔧 git push origin ${branch}` });
    const push = await this.workspace.io.exec(handle, `git push -u origin ${branch} 2>&1`);
    if (push.code !== 0) {
      log.error('git push failed', push.stdout || push.stderr);
      await this.channel.notify(rt.identifier, `❌ Branch push failed: ${(push.stdout || push.stderr).slice(-300)}`);
      bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: '❌ git push failed' });
      return;
    }

    let pr = await repo.findPullRequestByBranch(branch);
    const isNew = !pr;
    if (!pr) {
      pr = await repo.createPullRequest({
        title: String(meta.title),
        body: typeof meta.body === 'string' ? meta.body : '',
        head: branch,
        base,
      });
    }
    if (isNew) await this.postReviewToPr(rt, issue, repo, pr);
    await this.onPrCreated(rt, issue, { pr_number: pr.number, pr_url: pr.url });
  }

  /** Post the final self-review as a PR comment (history) — non-fatal. */
  private async postReviewToPr(rt: IssueRuntime, issue: Issue, repo: RepositoryAdapter, pr: PullRequest): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const review = await this.readOutput(handle, SCRATCH.prevReview);
    if (!review) return;
    const body = `## 🔍 Corral self-review\n\n_Issue ${issue.identifier} · automated review after the code change._\n\n${review}`;
    try {
      await repo.createPullRequestComment(pr, body);
      bus.emitEvent({ identifier: rt.identifier, kind: 'activity', label: `💬 Posted review comment on PR #${pr.number}` });
    } catch (err) {
      logger.child(rt.identifier).warn('failed to post review comment to PR', String(err));
      bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: '⚠️ Failed to post review comment (PR created fine)' });
    }
  }

  private async onPrCreated(rt: IssueRuntime, issue: Issue, pr: Record<string, unknown>): Promise<void> {
    const prUrl = typeof pr.pr_url === 'string' ? pr.pr_url : undefined;
    rt.pr = { number: pr.pr_number as number, branch: this.router.resolve(issue).branchNameFor(issue), url: prUrl };
    rt.phase = 'pr_open';
    rt.prSince = new Date().toISOString();
    this.store.upsert(rt);
    await this.tracker.transitionIssue(issue, 'in_review');
    await this.channel.notify(rt.identifier, `🔗 PR #${rt.pr.number} opened. After merging, press "Complete".`);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'pr_open', label: `🔗 PR #${rt.pr.number} opened — awaiting merge` });
    logger.child(rt.identifier).info(`PR #${rt.pr.number} open; awaiting user completion`);
  }

  // ─────────────────────────────────── completion (user-confirmed merge)

  private async completeIssue(identifier: string): Promise<void> {
    const rt = this.store.get(identifier);
    if (!rt) return;
    const log = logger.child(identifier);
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (issue) {
      await this.tracker.transitionIssue(issue, 'done');
      await this.tracker
        .createComment(issue, this.cost.formatComment(identifier, this.profile.t))
        .catch((err) => log.warn('cost comment failed (non-fatal)', String(err)));
    }
    const handle = this.handles.get(identifier);
    if (handle) {
      await this.workspace.cleanup(handle).catch(() => {});
      this.handles.delete(identifier);
    }
    const repo = this.router.byKey(rt.repoKey);
    if (repo && rt.pr) await repo.deleteBranch(rt.pr.branch).catch(() => {});
    if ('clearIssue' in this.channel) (this.channel as { clearIssue(id: string): void }).clearIssue(identifier);
    bus.emitEvent({ identifier, kind: 'phase', phase: 'done', label: '🎉 Done (cleaned up)' });
    this.cost.clear(identifier);
    this.store.delete(identifier);
    this.limiter.release(identifier);
    log.info('issue completed; workspace cleaned up');
  }

  /** Snapshot for the dashboard: each tracked issue + its accumulated cost. */
  snapshot(): Array<IssueRuntime & { cost: number }> {
    return this.store.all().map((rt) => ({ ...rt, cost: this.cost.get(rt.identifier)?.costUsd ?? 0 }));
  }

  // ─────────────────────────────────────────────────────────── helpers

  private async resendApproval(rt: IssueRuntime, issue: Issue, kind: 'plan' | 'review' | 'pr_plan', file: string): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const body = await this.readOutput(handle, file);
    if (!body) {
      await this.surfaceStuck(rt, `Feedback result (${file}) is empty — the agent did not write an update. Please retry.`);
      return;
    }
    const approvalId = await this.channel.sendApproval({
      identifier: rt.identifier,
      kind,
      title: issue.title,
      body,
      options: kind === 'plan' ? await this.planOptionsFor(handle) : undefined,
    });
    rt.approvalId = approvalId;
    this.store.upsert(rt);
  }

  private async uploadDiff(rt: IssueRuntime, issue: Issue, base: string): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const diff = await this.workspace.io.getDiff(handle, base);
    if (diff.trim()) await this.channel.uploadDiff(rt.identifier, `${issue.identifier}.diff`, diff);
  }

  /** Surface a dead-end instead of sitting mutely in a WAITING phase. */
  private async surfaceStuck(rt: IssueRuntime, message: string, retryable = false): Promise<void> {
    if (retryable) {
      rt.stuck = true;
      this.store.upsert(rt);
    }
    logger.child(rt.identifier).warn(`stuck: ${message}`);
    bus.emitEvent({ identifier: rt.identifier, kind: 'error', phase: rt.phase, label: `❌ ${message}` });
    await this.channel.notify(rt.identifier, `❌ ${message}`);
  }

  private clearApproval(rt: IssueRuntime): void {
    if (rt.approvalId && 'resolve' in this.channel) {
      (this.channel as { resolve(id: string): void }).resolve(rt.approvalId);
    }
    rt.approvalId = undefined;
  }

  private async wipeOutputs(handle: WorkspaceHandle): Promise<void> {
    await Promise.all([
      this.workspace.io.writeFile(handle, SCRATCH.pendingPlan, ''),
      this.workspace.io.writeFile(handle, SCRATCH.pendingReview, ''),
      this.workspace.io.writeFile(handle, SCRATCH.reply, ''),
    ]);
  }

  private async readOutput(handle: WorkspaceHandle, path: string): Promise<string | null> {
    const content = await this.workspace.io.readFile(handle, path);
    const trimmed = content?.trim();
    return trimmed ? trimmed : null;
  }

  private async readJson(handle: WorkspaceHandle, path: string): Promise<Record<string, unknown> | null> {
    const raw = await this.readOutput(handle, path);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private planningModel(): string | undefined {
    return this.config.agent.models.planning;
  }

  /** Review pipeline model — falls back to the planning model when unset. */
  private reviewModel(): string | undefined {
    return this.config.agent.models.review ?? this.config.agent.models.planning;
  }
}

/** Compact one-line error for UI messages. */
function oneLineErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 200);
}
