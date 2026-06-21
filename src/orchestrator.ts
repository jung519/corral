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
import { IssueStateStore, type IssuePr, type IssueRuntime } from './core/issue-state.js';
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
import type { ReviewTarget } from './review/prompt.js';
import { resolve } from 'node:path';
import { ensureWorkerImage } from './workspace/image/index.js';

/** Read-only reference/conventions repo clone path (under the workspace root). */
const REFERENCE_DIR = '.reference';

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
    /** Authenticated clone URL of the read-only reference/conventions repo (or undefined). */
    private readonly referenceCloneUrl?: string,
  ) {
    this.review = new ReviewOrchestrator(workspace.io, agent, config.review, profile, config.agent.turn_timeout_ms);
    this.planCritique = new PlanCritiqueOrchestrator(
      workspace.io,
      agent,
      config.plan_review,
      profile,
      config.agent.turn_timeout_ms,
    );
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

    // Clone every configured repo side by side; the agent decides which to change.
    const repos = this.router.all();

    // Docker + no explicit image → auto-build a worker image first. That's slow
    // (clone manifests → generate Dockerfile → build), so the whole setup runs
    // asynchronously; the API returns immediately and progress streams as events.
    const dockerCfg = this.config.workspace.backend === 'docker' ? this.config.workspace.docker : undefined;
    if (this.config.workspace.backend === 'docker' && !dockerCfg?.image && (dockerCfg?.auto_build ?? true)) {
      return this.startIssueWithAutoImage(identifier, issue, repos);
    }

    let handle;
    try {
      logger.child(identifier).info(`creating workspace (${repos.length} repo(s))`);
      handle = await this.workspace.create({
        identifier,
        repos: repos.map((r) => ({ key: r.key, cloneUrl: r.cloneUrl(), baseBranch: r.baseBranchFor(issue) })),
        image: repos.length === 1 ? repos[0]!.workerImage : undefined,
        extraRepos: this.referenceCloneUrl ? [{ cloneUrl: this.referenceCloneUrl, path: REFERENCE_DIR }] : undefined,
      });
    } catch (err) {
      this.limiter.release(identifier);
      logger.child(identifier).error('workspace create failed', String(err));
      return { ok: false, message: `Workspace creation failed: ${oneLineErr(err)}` };
    }
    this.handles.set(identifier, handle);

    // Capture each repo's base commit now (the review diff scope), so we don't rely
    // on the agent to record it.
    const baseCommits: Record<string, string> = {};
    for (const r of repos) {
      const res = await this.workspace.io.exec(handle, `git -C ${shq(r.key)} rev-parse HEAD`);
      if (res.code === 0) baseCommits[r.key] = res.stdout.trim();
    }

    const repoKey = (issue.repoKey && repos.some((r) => r.key === issue.repoKey) ? issue.repoKey : repos[0]?.key) ?? '';
    const rt: IssueRuntime = { identifier, repoKey, phase: 'initial', title: issue.title, url: issue.url, baseCommits };
    this.store.upsert(rt);
    bus.emitEvent({ identifier, kind: 'phase', phase: 'planning', label: `📋 Planning started — ${issue.title}` });

    void this.serialize(identifier, () => this.prepareAndPlan(rt, issue, repos, handle));
    return { ok: true };
  }

  /** Per-repo afterClone hooks → attachments → planning dispatch. Shared by the sync
   * (local / BYO image) and async (docker auto-build) start paths. */
  private async prepareAndPlan(rt: IssueRuntime, issue: Issue, repos: RepositoryAdapter[], handle: WorkspaceHandle): Promise<void> {
    const identifier = rt.identifier;
    for (const r of repos) {
      if (!r.afterClone) continue;
      bus.emitEvent({ identifier, kind: 'notice', label: `📦 Installing dependencies (${r.key}) — ${r.afterClone}` });
      const res = await this.workspace.io.exec(handle, `cd ${shq(r.key)} && ${r.afterClone}`);
      if (res.code !== 0) {
        bus.emitEvent({
          identifier,
          kind: 'notice',
          label: `⚠️ Dependency install failed (${r.key}: ${r.afterClone}, code ${res.code}) — static gate/build may break`,
        });
        logger.child(identifier).warn(`after_clone failed (${r.key})`, res.stderr.slice(-400));
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
  }

  /** Docker auto-build start path: build/ensure the worker image, then create the
   * workspace and plan — all async so the API returns immediately. */
  private async startIssueWithAutoImage(
    identifier: string,
    issue: Issue,
    repos: RepositoryAdapter[],
  ): Promise<{ ok: boolean; message?: string }> {
    const repoKey = (issue.repoKey && repos.some((r) => r.key === issue.repoKey) ? issue.repoKey : repos[0]?.key) ?? '';
    const rt: IssueRuntime = { identifier, repoKey, phase: 'initial', title: issue.title, url: issue.url };
    this.store.upsert(rt);
    bus.emitEvent({ identifier, kind: 'notice', label: '🐳 Preparing worker image…' });

    void this.serialize(identifier, async () => {
      try {
        const result = await ensureWorkerImage({
          prepRoot: resolve(this.config.workspace.root, '.corral-image-prep', identifier),
          repos: repos.map((r) => ({ key: r.key, cloneUrl: r.cloneUrl(), baseBranch: r.baseBranchFor(issue) })),
          // Approval = config opt-in (workspace.docker.auto_build) + the Dockerfile is
          // surfaced here for audit. (A per-build modal can be layered on this seam.)
          approve: (dockerfile) => {
            bus.emitEvent({ identifier, kind: 'notice', label: `🐳 Worker Dockerfile generated (${dockerfile.split('\n').length} lines) — building` });
            logger.child(identifier).info(`worker Dockerfile:\n${dockerfile}`);
            return Promise.resolve(true);
          },
          onLog: (line) => bus.emitEvent({ identifier, kind: 'activity', label: `🐳 ${line.slice(0, 2000)}` }),
        });
        if (!result.ok) {
          this.store.delete(identifier);
          this.limiter.release(identifier);
          bus.emitEvent({ identifier, kind: 'error', label: `❌ Worker image ${result.reason}${result.message ? `: ${result.message}` : ''}` });
          return;
        }
        bus.emitEvent({ identifier, kind: 'notice', label: `🐳 Worker image ready (${result.cached ? 'cached' : 'built'}): ${result.tag}` });

        const handle = await this.workspace.create({
          identifier,
          repos: repos.map((r) => ({ key: r.key, cloneUrl: r.cloneUrl(), baseBranch: r.baseBranchFor(issue) })),
          image: result.tag,
          extraRepos: this.referenceCloneUrl ? [{ cloneUrl: this.referenceCloneUrl, path: REFERENCE_DIR }] : undefined,
        });
        this.handles.set(identifier, handle);

        const baseCommits: Record<string, string> = {};
        for (const r of repos) {
          const res = await this.workspace.io.exec(handle, `git -C ${shq(r.key)} rev-parse HEAD`);
          if (res.code === 0) baseCommits[r.key] = res.stdout.trim();
        }
        rt.baseCommits = baseCommits;
        this.store.upsert(rt);
        bus.emitEvent({ identifier, kind: 'phase', phase: 'planning', label: `📋 Planning started — ${issue.title}` });

        await this.prepareAndPlan(rt, issue, repos, handle);
      } catch (err) {
        this.store.delete(identifier);
        this.limiter.release(identifier);
        bus.emitEvent({ identifier, kind: 'error', label: `❌ Setup failed: ${oneLineErr(err)}` });
      }
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

    if (!force && rt.prs?.length) {
      for (const p of rt.prs) {
        const repo = this.router.byKey(p.repoKey);
        const pr = repo ? await repo.refreshPullRequest(p.number).catch(() => null) : null;
        if (!pr?.merged) {
          return { ok: false, merged: false, message: `PR #${p.number} (${p.repoKey}) is not merged yet.` };
        }
      }
    }
    await this.serialize(identifier, () => this.completeIssue(identifier));
    return { ok: true };
  }

  /** Drop an issue from Corral: clean the workspace + untrack it, WITHOUT touching the
   * tracker or any branch. For a stuck/abandoned run so the user can re-pick it later. */
  async removeIssue(identifier: string): Promise<{ ok: boolean; message?: string }> {
    const rt = this.store.get(identifier);
    if (!rt) return { ok: false, message: 'Not tracked.' };
    await this.serialize(identifier, async () => {
      const handle = this.handles.get(identifier);
      if (handle) {
        await this.workspace.cleanup(handle).catch(() => {});
        this.handles.delete(identifier);
      }
      this.clearApproval(rt);
      if ('clearIssue' in this.channel) (this.channel as { clearIssue(id: string): void }).clearIssue(identifier);
      bus.emitEvent({ identifier, kind: 'notice', label: '🗑 Removed from Corral (workspace cleaned, tracker untouched)' });
      this.cost.clear(identifier);
      this.store.delete(identifier);
      this.limiter.release(identifier);
      logger.child(identifier).info('issue removed by user');
    });
    return { ok: true };
  }

  /** Hard-restart an issue from scratch (for errors / hangs that retry can't resume):
   * force-tear-down the current run — even mid-flight — then run startIssue again. */
  async restartIssue(identifier: string): Promise<{ ok: boolean; message?: string }> {
    const rt = this.store.get(identifier);
    if (rt) {
      const handle = this.handles.get(identifier);
      if (handle) {
        await this.workspace.cleanup(handle).catch(() => {});
        this.handles.delete(identifier);
      }
      this.clearApproval(rt);
      this.cost.clear(identifier);
      this.store.delete(identifier);
      this.limiter.release(identifier);
      // Reset in-flight tracking so a hung run can't block or race the fresh start.
      this.busy.delete(identifier);
      this.chains.delete(identifier);
      bus.emitEvent({ identifier, kind: 'notice', label: '🔄 Restarting from scratch' });
      logger.child(identifier).info('issue restarted from scratch by user');
    }
    return this.startIssue(identifier);
  }

  // ─────────────────────────────────────────────────── planning (Branch A)

  /** Reference repo path inside the workspace for the agent to consult (undefined if
   * no reference repo is configured). Cloned read-only into REFERENCE_DIR at create. */
  private referencePath(): string | undefined {
    return this.referenceCloneUrl ? REFERENCE_DIR : undefined;
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

    if (this.busy.has(rt.identifier)) {
      logger.child(rt.identifier).warn('dispatch requested while busy; skipping');
      return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'crashed' };
    }
    this.busy.add(rt.identifier);
    try {
      const workflow = await renderWorkflow({
        issue,
        tracker_kind: this.tracker.kind,
        language: this.profile.languageName,
        repos: this.router.all().map((r) => ({
          key: r.key,
          dir: r.key,
          description: r.description,
          base_branch: r.baseBranchFor(issue),
          branch: r.branchNameFor(issue),
        })),
        reference_path: this.referencePath(),
      });
      await this.wipeOutputs(handle);
      const a = this.config.agent;
      const result = await this.agent.run(handle, issue, {
        stage,
        workflow,
        prompt,
        continueSession,
        // Apply the configured limits — without these a hung agent runs forever.
        turnTimeoutMs: a.turn_timeout_ms,
        maxTurns: a.max_turns,
        maxBudgetUsd: a.max_budget_usd,
        allowedTools: a.allowed_tools,
      });
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
      // Manual review flow: the human's text drives the next step. The agent applies the
      // instruction — editing + committing code if asked — then we re-review ONCE and
      // present again (clean → PR, findings → card). No automatic fix→re-review loop.
      this.clearApproval(rt);
      const result = await this.dispatch(rt, issue, signal, true, 'implementation');
      if (!result.ok) return;
      await this.presentReview(rt, issue);
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

  /** Post-implementation tail: question → diff guard → present the self-review. */
  private async reviewAfterImplement(rt: IssueRuntime, issue: Issue): Promise<void> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;

    if (await this.handleQuestion(rt, handle)) return;

    const changed = await this.changedRepoKeys(handle, rt, issue);
    if (changed.length === 0) {
      log.error('no committed diff in any repo after implementation');
      // Retryable: the agent may not have committed yet, or a transient git issue.
      // Retry resumes implementation and re-checks — the existing commit is reused.
      await this.surfaceStuck(
        rt,
        'No committed changes detected in any repo. The agent may not have committed — press Retry to re-check / resume.',
        true,
      );
      return;
    }
    bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: `🗂 Changed repos: ${changed.join(', ')}` });

    await this.presentReview(rt, issue);
  }

  /**
   * Run the self-review once over the changed repos and route the result:
   *   - clean (no BLOCKER/SUGGESTION) + auto_pr_when_clean → open the PR automatically
   *   - findings remain → present to the human (review_sent); NO auto-fix (manual mode)
   * Shared by the initial post-implementation review and post-feedback re-reviews.
   * (With review.max_fix_rounds > 0, selfReviewLoop still auto-fixes internally.)
   */
  private async presentReview(rt: IssueRuntime, issue: Issue): Promise<void> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;
    const review = await this.selfReviewLoop(rt, issue, handle);
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
    bus.emitEvent({
      identifier: rt.identifier,
      kind: 'approval',
      phase: 'review_sent',
      label: '🔔 Action needed — review (✅ approve = PR / text = edit + re-review)',
    });
  }

  /** Self-review with an auto-fix loop. Returns the final review (fixes applied), or null. */
  private async selfReviewLoop(rt: IssueRuntime, issue: Issue, handle: WorkspaceHandle): Promise<string | null> {
    const log = logger.child(rt.identifier);
    const maxFixRounds = this.config.review.max_fix_rounds;
    for (let round = 0; ; round++) {
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'phase',
        phase: 'reviewing',
        label: round === 0 ? '🔍 Self-reviewing' : `🔍 Re-reviewing (after ${round} auto-fix round(s))`,
      });
      // Re-scope each round: an auto-fix may touch additional repos.
      const changed = await this.changedRepoKeys(handle, rt, issue);
      const targets = this.reviewTargets(rt, issue, changed);
      const diff = await this.combinedDiff(handle, rt, issue, changed);
      const diffStats = { lines: 0, files: 0 };
      for (const l of diff.split('\n')) {
        if (l.startsWith('diff --git ')) diffStats.files++;
        else if ((l[0] === '+' && !l.startsWith('+++')) || (l[0] === '-' && !l.startsWith('---'))) diffStats.lines++;
      }
      const verifyCommands = changed.flatMap((k) =>
        (this.router.byKey(k)?.verifyCommands ?? []).map((c) => `cd ${shq(k)} && ${c}`),
      );
      await this.review.run(
        handle,
        issue,
        targets,
        this.reviewModel(),
        this.referencePath(),
        (r) => this.cost.add(rt.identifier, r),
        verifyCommands,
        diffStats,
      );
      await this.uploadDiff(rt, issue, changed);
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

    // Manual flow: approval always opens the PR with the current code — no fix plan.
    const meta = await this.readJson(handle, SCRATCH.prMeta);
    if (meta && typeof meta.title === 'string') {
      await this.pushAndCreatePr(rt, issue, meta);
      return;
    }
    await this.surfaceStuck(
      rt,
      'After review approval, no PR metadata (.corral/pr_meta.json) was produced. Approval always opens a PR — check the agent output and retry.',
      true,
    );
  }

  private async implementFix(rt: IssueRuntime, issue: Issue): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const result = await this.dispatch(rt, issue, this.signals.approve, true, 'implementation');
    if (!result.ok) return;
    const meta = await this.readJson(handle, SCRATCH.prMeta);
    if (meta && typeof meta.title === 'string') await this.pushAndCreatePr(rt, issue, meta);
  }

  /** Orchestrator-owned push + PR creation — one PR per repo the agent changed. */
  private async pushAndCreatePr(rt: IssueRuntime, issue: Issue, meta: Record<string, unknown>): Promise<void> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;
    const changed = await this.changedRepoKeys(handle, rt, issue);
    if (changed.length === 0) {
      await this.surfaceStuck(rt, 'No changes to open a PR for (empty diff in every repo).');
      return;
    }
    const title = String(meta.title);
    const body = typeof meta.body === 'string' ? meta.body : '';
    const prs: IssuePr[] = [];
    for (const key of changed) {
      const repo = this.router.byKey(key);
      if (!repo) continue;
      const branch = repo.branchNameFor(issue);
      const base = repo.baseBranchFor(issue);
      bus.emitEvent({ identifier: rt.identifier, kind: 'activity', label: `🔧 git -C ${key} push origin ${branch}` });
      const push = await this.workspace.io.exec(handle, `git -C ${shq(key)} push -u origin ${branch} 2>&1`);
      if (push.code !== 0) {
        log.error(`git push failed (${key})`, push.stdout || push.stderr);
        await this.channel.notify(rt.identifier, `❌ Branch push failed (${key}): ${(push.stdout || push.stderr).slice(-300)}`);
        bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: `❌ git push failed (${key})` });
        continue;
      }
      let pr = await repo.findPullRequestByBranch(branch);
      const isNew = !pr;
      if (!pr) {
        pr = await repo.createPullRequest({
          title: changed.length > 1 ? `${title} (${key})` : title,
          body,
          head: branch,
          base,
        });
      }
      if (isNew) await this.postReviewToPr(rt, issue, repo, pr);
      prs.push({ repoKey: key, number: pr.number, branch, url: pr.url });
    }
    if (prs.length === 0) {
      await this.surfaceStuck(rt, 'Failed to open any PR (all pushes failed). Check tokens/permissions and retry.', true);
      return;
    }
    await this.onPrCreated(rt, issue, prs);
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

  private async onPrCreated(rt: IssueRuntime, issue: Issue, prs: IssuePr[]): Promise<void> {
    rt.prs = prs;
    rt.phase = 'pr_open';
    rt.prSince = new Date().toISOString();
    this.store.upsert(rt);
    await this.tracker.transitionIssue(issue, 'in_review');
    const list = prs.map((p) => `#${p.number} (${p.repoKey})`).join(', ');
    await this.channel.notify(rt.identifier, `🔗 PR(s) opened: ${list}. After merging all, press "Complete".`);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'pr_open', label: `🔗 ${prs.length} PR(s) opened — awaiting merge` });
    logger.child(rt.identifier).info(`${prs.length} PR(s) open; awaiting user completion`);
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
    for (const p of rt.prs ?? []) {
      const repo = this.router.byKey(p.repoKey);
      if (repo) await repo.deleteBranch(p.branch).catch(() => {});
    }
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

  private async uploadDiff(rt: IssueRuntime, issue: Issue, keys: string[]): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const diff = await this.combinedDiff(handle, rt, issue, keys);
    if (diff.trim()) await this.channel.uploadDiff(rt.identifier, `${issue.identifier}.diff`, diff);
  }

  // ───────────────────────────────────────────────── multi-repo diff helpers

  /** Diff base for a repo: the commit captured at clone, or — if that wasn't recorded
   * (e.g. an older build, or a recovered workspace) — the base BRANCH it was cloned
   * from. Robust so a missing baseCommit can't silently hide the agent's changes. */
  private baseFor(rt: IssueRuntime, issue: Issue, key: string): string | undefined {
    return rt.baseCommits?.[key] ?? this.router.byKey(key)?.baseBranchFor(issue);
  }

  /** Repo keys whose clone has a non-empty diff vs its base (commit or base branch). */
  private async changedRepoKeys(handle: WorkspaceHandle, rt: IssueRuntime, issue: Issue): Promise<string[]> {
    const keys: string[] = [];
    for (const repo of this.router.all()) {
      const base = this.baseFor(rt, issue, repo.key);
      if (!base) continue;
      const diff = await this.workspace.io.getDiff(handle, base, repo.key);
      if (diff.trim()) keys.push(repo.key);
    }
    return keys;
  }

  /** Review diff targets (subdir + base) for the given changed repo keys. */
  private reviewTargets(rt: IssueRuntime, issue: Issue, keys: string[]): ReviewTarget[] {
    return keys
      .map((k) => ({ dir: k, base: this.baseFor(rt, issue, k) }))
      .filter((t): t is ReviewTarget => Boolean(t.base));
  }

  /** Combined diff across the given repos, each section headed by its subdir. */
  private async combinedDiff(handle: WorkspaceHandle, rt: IssueRuntime, issue: Issue, keys: string[]): Promise<string> {
    let out = '';
    for (const k of keys) {
      const base = this.baseFor(rt, issue, k);
      if (!base) continue;
      const diff = await this.workspace.io.getDiff(handle, base, k);
      if (diff.trim()) out += `\n# ===== ${k}/ =====\n${diff}`;
    }
    return out;
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

/** Single-quote a string for safe interpolation into a shell command (repo keys can
 * contain spaces/special chars). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
