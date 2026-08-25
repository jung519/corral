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
import { buildSignals, directionCheckPrompt, kickoffPrompt, PROMPTS, renderWorkflow, type Signals } from './agent/prompt-builder.js';
import { consolidateSpecPrompt, nextSpecStage, specDoc, specStagePrompt, SPEC_STAGES, taskPrompt, type SpecStage } from './agent/prompt-builder.js';
import { parseSpecTasks } from './core/spec-tasks.js';
import { nextTaskStep, type TaskLoopState } from './core/task-loop.js';
import { isUnbacked, taskEvidence, type RepoHeads, type TaskEvidence } from './core/task-evidence.js';
import { TimingAgent } from './agent/timing-agent.js';
import { unrunnableProvider } from './agent/backend-compat.js';
import type { Config } from './config/schema.js';
import { ConcurrencyLimiter } from './core/concurrency-limiter.js';
import { CostTracker } from './core/cost-tracker.js';
import type { TokenBudget } from './core/token-budget.js';
import { bus } from './core/events.js';
import { renderMarkdown } from './core/markdown.js';
import {
  type HistoryPhase,
  type HistoryRecord,
  HISTORY_SCHEMA_VERSION,
  type IssueOutcome,
  JsonlHistoryStore,
} from './core/issue-history.js';
import { IssueStateStore, type IssuePr, type IssueRuntime } from './core/issue-state.js';
import { logger } from './core/logger.js';
import { type DirectionCheckStore, type DirectionStore, parseDirectionVerdict } from './core/direction.js';
import { SCRATCH, SCRATCH_DIR, SPEC } from './core/paths.js';
import { wipeProduced } from './core/scratch-outputs.js';
import { describeUncommitted, uncommittedAcross } from './core/uncommitted.js';
import { fixableCount, isReviewClean, parseReviewStatus, unmetCriteria, type ReviewStatus } from './core/review-status.js';
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
import type { ApprovalDetail,
  ApprovalKind,
  IssuePhase,
} from './core/types.js';
import type { ResolvedProfile } from './profile/index.js';
import type { RepositoryRouter } from './repository/router.js';
import { PlanCritiqueOrchestrator } from './review/plan-critique.js';
import { ReviewOrchestrator } from './review/orchestrator.js';
import type { ReviewTarget } from './review/prompt.js';
import { resolve } from 'node:path';
import { dockerDaemonRunning } from './workspace/docker.js';
import { ensureWorkerImage } from './workspace/image/index.js';

/** Read-only reference/conventions repo clone path (under the workspace root). */
const REFERENCE_DIR = '.reference';

export class Orchestrator {
  private readonly review: ReviewOrchestrator;
  private readonly planCritique: PlanCritiqueOrchestrator;
  private readonly cost: CostTracker;
  private readonly history = new JsonlHistoryStore();
  /** Timing-wrapped agent (measures AI working time); the injected adapter is wrapped. */
  private readonly agent: AgentAdapter;
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
    agent: AgentAdapter,
    private readonly channel: ChannelAdapter,
    private readonly profile: ResolvedProfile,
    /** Authenticated clone URL of the read-only reference/conventions repo (or undefined). */
    private readonly referenceCloneUrl?: string,
    /** Global Direction reader — merged with per-project `.corral/DIRECTION.md` on dispatch. */
    private readonly directionStore?: DirectionStore,
    /** Direction validation state (consent + per-scope verified hashes). */
    private readonly directionCheck?: DirectionCheckStore,
    /** Daily token ceiling, shared with the operational AI. */
    private readonly budget?: TokenBudget,
  ) {
    this.cost = new CostTracker(undefined, budget);
    // Wrap the agent once so every turn — planning, critique, review — is timed into
    // the issue's "AI working" total (recorded in the history entry on completion).
    this.agent = new TimingAgent(agent, (id, ms) => this.recordAgentMs(id, ms));
    this.review = new ReviewOrchestrator(workspace.io, this.agent, config.review, profile, config.agent.turn_timeout_ms);
    this.planCritique = new PlanCritiqueOrchestrator(
      workspace.io,
      this.agent,
      config.plan_review,
      profile,
      config.agent.turn_timeout_ms,
    );
    this.limiter = new ConcurrencyLimiter(config.max_active_issues);
    this.signals = buildSignals(profile.t);

    this.channel.onApprove((id, detail) => this.handleApprove(id, detail));
    this.channel.onFeedback((id, text) => this.handleFeedback(id, text));
  }

  /** Provider-specific guidance when the agent has no/invalid credential (login_required). */
  private loginHelp(): string {
    switch (this.config.agent.provider) {
      case 'claude':
        return '⚠️ Claude 인증이 안 됩니다(로그인/자격증명 없음). 호스트에서 claude 로그인 또는 구독 토큰(claude setup-token)을 설정한 뒤 다시 시도하세요.';
      case 'gemini':
        return '⚠️ Gemini 인증이 안 됩니다. GEMINI_API_KEY를 설정하거나 gemini 로그인 후 다시 시도하세요.';
      default:
        return `⚠️ ${this.config.agent.provider} 인증이 안 됩니다(자격증명 없음/무효). 설정에서 키 또는 로그인을 확인하세요.`;
    }
  }

  /** Accumulate an agent turn's duration onto the issue (persisted, survives restart). */
  private recordAgentMs(identifier: string, ms: number): void {
    const rt = this.store.get(identifier);
    if (!rt) return;
    rt.agentActiveMs = (rt.agentActiveMs ?? 0) + ms;
    this.store.upsert(rt);
  }

  /** Append a terminal history record for an issue (called just before it's dropped
   *  from the live store). Tracker-independent: title/url/kind are snapshotted here. */
  private archive(rt: IssueRuntime, outcome: IssueOutcome): void {
    try {
      const record = this.buildHistoryRecord(rt, outcome);
      // Skip trivially-empty attempts (e.g. a restart right after start, or an aborted
      // setup): no agent work, no dispatch, no PR. Recording these as "failed" is noise
      // and collides in the list with the live re-run of the same id. Completed runs are
      // always kept (completion is meaningful even if cheap).
      if (outcome !== 'completed' && record.dispatches === 0 && record.agentActiveMs === 0 && record.prs.length === 0) {
        return;
      }
      this.history.append(record);
    } catch (err) {
      logger.child(rt.identifier).warn('history archive failed (non-fatal)', String(err));
    }
  }

  private buildHistoryRecord(rt: IssueRuntime, outcome: IssueOutcome): HistoryRecord {
    const endedAt = Date.now();
    const startedAt = rt.startedAt ?? endedAt;
    const wallMs = Math.max(0, endedAt - startedAt);
    const agentActiveMs = rt.agentActiveMs ?? 0;

    // Phase timeline + setup time, derived from this issue's events (still buffered
    // until cleanup clears them). setup = start → first "planning" phase (image+clone).
    const phaseEvents = bus.recent(rt.identifier).filter((e) => e.kind === 'phase' && e.phase);
    const phases: HistoryPhase[] = phaseEvents.map((e, i) => ({
      phase: e.phase!,
      at: e.ts,
      durationMs: Math.max(0, (i + 1 < phaseEvents.length ? phaseEvents[i + 1]!.ts : endedAt) - e.ts),
    }));
    const firstPlanning = phaseEvents.find((e) => e.phase === 'planning');
    const setupMs = firstPlanning ? Math.max(0, firstPlanning.ts - startedAt) : 0;
    const humanWaitMs = Math.max(0, wallMs - agentActiveMs - setupMs);
    const failoverUsed = bus
      .recent(rt.identifier)
      .some((e) => e.label.includes('소진') || e.label.includes('전환') || e.label.toLowerCase().includes('failover'));

    const cost = this.cost.get(rt.identifier);
    const repoKeys = Object.keys(rt.baseCommits ?? {});

    return {
      v: HISTORY_SCHEMA_VERSION,
      identifier: rt.identifier,
      title: rt.title,
      url: rt.url,
      trackerKind: this.tracker.kind,
      repoKeys: repoKeys.length ? repoKeys : this.router.all().map((r) => r.key),
      backend: this.config.workspace.backend,
      outcome,
      prs: (rt.prs ?? []).map((p) => ({ repoKey: p.repoKey, number: p.number, url: p.url })),
      startedAt,
      endedAt,
      wallMs,
      agentActiveMs,
      humanWaitMs,
      setupMs,
      dispatches: cost?.dispatches ?? 0,
      phases,
      costUsd: cost?.costUsd ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
      models: {
        planning: this.config.agent.models.planning ?? '',
        implementation: this.config.agent.models.implementation ?? '',
        review: this.config.agent.models.review ?? '',
      },
      agentProvider: this.config.agent.provider,
      failoverUsed,
      qa: rt.qa?.length ? rt.qa : undefined,
    };
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
        this.archive(rt, 'failed');
        this.store.delete(rt.identifier);
      } else {
        active.push(rt.identifier); // PR open: still tracked for comments/merge
      }
    }
    this.limiter.seed(active);
  }

  /** Re-create a lost pending approval from the workspace's `.corral/` file. */
  private async recoverPendingApproval(rt: IssueRuntime, handle: WorkspaceHandle): Promise<void> {
    const spec: Record<string, { file: string; kind: ApprovalKind }> = {
      plan_sent: { file: SCRATCH.pendingPlan, kind: 'plan' },
      pr_plan_sent: { file: SCRATCH.pendingPlan, kind: 'pr_plan' },
      review_sent: { file: SCRATCH.pendingReview, kind: 'review' },
      // The spec gates recover the same way — the card is rebuilt from the document the
      // human was looking at. Listed here rather than with the flow that raises them
      // (CRL-103) because it is the file paths that were missing, and they exist now.
      requirements_sent: { file: SPEC.requirements, kind: 'requirements' },
      design_sent: { file: SPEC.design, kind: 'design' },
      tasks_sent: { file: SPEC.tasks, kind: 'tasks' },
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
  async listCandidates(opts?: { cursor?: string; limit?: number }): Promise<{
    candidates: Array<{ identifier: string; title: string; state: string; repoKey?: string; url?: string; inFlight: boolean }>;
    nextCursor?: string;
  }> {
    const { items, nextCursor } = await this.tracker.fetchCandidatePage({ cursor: opts?.cursor, limit: opts?.limit ?? 10 });
    const candidates = items.map((i) => ({
      identifier: i.identifier,
      title: i.title,
      state: i.state,
      repoKey: i.repoKey,
      url: i.url,
      inFlight: this.store.get(i.identifier) !== undefined,
    }));
    return { candidates, nextCursor };
  }

  /** Begin work on an issue. Creates the workspace synchronously so failures surface immediately. */
  async startIssue(identifier: string): Promise<{ ok: boolean; message?: string }> {
    if (this.store.get(identifier)) return { ok: false, message: 'Already in progress.' };
    const issue = await this.tracker.fetchIssueByIdentifier(identifier);
    if (!issue) return { ok: false, message: 'Issue not found.' };
    if (!this.limiter.tryAcquire(identifier)) return { ok: false, message: 'Concurrency limit reached.' };

    // Docker backend needs a RUNNING daemon (not just the CLI). Check up front so a
    // stopped Docker Desktop gives a clear message instead of a cryptic build failure.
    if (this.config.workspace.backend === 'docker' && !(await dockerDaemonRunning())) {
      this.limiter.release(identifier);
      return {
        ok: false,
        message: 'Docker가 실행 중이 아닙니다. Docker Desktop을 켠 뒤 다시 시도하세요.',
      };
    }

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
    const rt: IssueRuntime = { identifier, repoKey, phase: 'initial', title: issue.title, url: issue.url, baseCommits, startedAt: Date.now() };
    this.store.upsert(rt);
    bus.emitEvent({ identifier, kind: 'phase', phase: 'planning', label: `📋 Planning started — ${issue.title}` });
    // Move the tracker out of the backlog on start so a started issue is visibly distinct
    // from untouched "todo" items. Target is the mapped `planning` state (config.tracker.
    // states.planning) — map it to a column of its own to separate, or to the same column
    // as in_progress to read "started = in progress". Non-fatal: a write failure won't
    // block the run.
    void this.tracker.transitionIssue(issue, 'planning').catch((err) => {
      logger.child(identifier).warn('tracker transition → planning failed (non-fatal)', String(err));
    });

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
    const rt: IssueRuntime = { identifier, repoKey, phase: 'initial', title: issue.title, url: issue.url, startedAt: Date.now() };
    this.store.upsert(rt);
    bus.emitEvent({ identifier, kind: 'notice', label: '🐳 Preparing worker image…' });

    void this.serialize(identifier, async () => {
      try {
        const result = await ensureWorkerImage({
          prepRoot: resolve(this.config.workspace.root, '.corral-image-prep', identifier),
          repos: repos.map((r) => ({ key: r.key, cloneUrl: r.cloneUrl(), baseBranch: r.baseBranchFor(issue) })),
          // Install a CLI for the primary provider + every fallback + every per-stage
          // agent, so cross-provider routing/failover works inside the container. Missing
          // a per-stage provider (e.g. review=gpt → codex) makes that stage crash at run.
          agentProviders: [
            ...new Set([
              this.config.agent.provider,
              ...this.config.agent.fallbacks.map((f) => f.provider),
              ...Object.values(this.config.agent.stages ?? {}).map((s) => s.provider),
            ]),
          ],
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
          this.archive(rt, 'failed');
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
        logger.child(identifier).error('setup failed', oneLineErr(err));
        this.archive(rt, 'failed');
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
    // States like auth_error_waiting can't be re-run in place — tell the user to Restart
    // instead of emitting a wall of red timeline errors from a doomed re-dispatch.
    if (!RETRYABLE_PHASES.has(rt.phase)) {
      return { ok: false, message: `이 상태('${rt.phase}')는 재시도할 수 없습니다. '재시작'을 눌러 처음부터 다시 실행하세요.` };
    }
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
        const result = await this.dispatch(rt, issue, msg, true, 'planning', [SCRATCH.pendingPlan]);
        if (result.ok) await this.afterPlanProduced(rt, issue, kind);
        return;
      }
      case 'implementing':
      case 'review_fixing':
        await this.resumeImplementing(rt, issue);
        return;
      // The code is already committed; the only thing the restart cost is the critique.
      // Re-running the whole implementation would talk over work that is already done.
      case 'reviewing':
        await this.presentReview(rt, issue);
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
      this.archive(rt, 'removed');
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
      this.archive(rt, 'failed'); // the aborted attempt is part of the history
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

  /** The global Direction text to inject — only if it's VERIFIED (§15); unverified text is
   * never injected. '' → the workflow's `{% if direction %}` block renders nothing. Read
   * fresh per dispatch so edits apply without a core restart. */
  private buildDirection(): string {
    const text = (this.directionStore?.read() ?? '').trim();
    return text && this.directionCheck?.isVerified('global', text) ? text : '';
  }

  /**
   * Direction validation gate (§15, checkpoint 2). Runs at planning start: any non-empty
   * Direction text that isn't already verified is checked by an AI turn. Rejected text
   * BLOCKS the issue; approved text is recorded (hash) so it's injected. Without user
   * consent nothing is spent — unverified scopes simply won't be injected. Returns false
   * if the issue was blocked (caller must stop). */
  private async runDirectionCheck(rt: IssueRuntime, issue: Issue, handle: WorkspaceHandle): Promise<boolean> {
    const check = this.directionCheck;
    if (!check) return true;
    const text = (this.directionStore?.read() ?? '').trim();
    if (!text || check.isVerified('global', text)) return true;

    if (!check.getConsent()) {
      // No consent → do NOT spend AI. The unverified Direction is skipped (buildDirection
      // filters it out); tell the user how to enable the check.
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'activity',
        phase: rt.phase,
        label: `💬 방향성이 미검토라 이번 작업에 적용되지 않습니다 — 설정에서 AI 검토를 허용하세요.`,
      });
      return true;
    }

    const verdict = await this.validateDirectionText(handle, issue, '방향성', text);
    if (!verdict.ran) {
      // Infra failure (agent error / no parseable verdict): don't block, don't verify —
      // the Direction just isn't injected this run and is re-checked next start.
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'activity',
        phase: rt.phase,
        label: `💬 방향성 검토를 완료하지 못했습니다 — 이번 작업엔 미적용, 다음 시작 시 재시도.`,
      });
      return true;
    }
    bus.emitEvent({
      identifier: rt.identifier,
      kind: 'activity',
      phase: rt.phase,
      label: `💬 방향성 검토 완료 — $${verdict.cost.toFixed(4)} 사용`,
    });
    if (verdict.approved) {
      check.markVerified('global', text);
      return true;
    }
    // Rejected → block the issue (fix the direction and restart).
    const msg = `방향성이 검토를 통과하지 못했습니다: ${verdict.reason} — 방향성을 비우거나 수정한 뒤 다시 시작하세요.`;
    rt.phase = 'auth_error_waiting';
    rt.stuck = true;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'error', phase: rt.phase, label: `❌ ${msg}` });
    await this.channel.notify(rt.identifier, `❌ ${msg}`).catch(() => {});
    return false;
  }

  /** Run a single AI turn that judges one Direction text and writes a JSON verdict. */
  private async validateDirectionText(
    handle: WorkspaceHandle,
    issue: Issue,
    label: string,
    text: string,
  ): Promise<{ ran: boolean; approved: boolean; reason: string; cost: number }> {
    await this.workspace.io.writeFile(handle, SCRATCH.directionCheck, '').catch(() => {});
    const result = await this.agent.run(handle, issue, {
      stage: 'planning',
      workflow: '', // self-contained — no workflow guide, judges the text only
      prompt: directionCheckPrompt(label, text, SCRATCH.directionCheck, this.profile.languageName),
      continueSession: false,
      turnTimeoutMs: this.config.agent.turn_timeout_ms,
      allowedTools: ['read', 'ls', 'write'],
    });
    // Count the check in the issue's cost total (the event only displays it).
    this.cost.add(issue.identifier, result);
    const raw = await this.workspace.io.readFile(handle, SCRATCH.directionCheck).catch(() => null);
    const verdict = parseDirectionVerdict(raw);
    if (!result.ok || !verdict) {
      return { ran: false, approved: false, reason: '(no verdict)', cost: result.costUsd ?? 0 };
    }
    return { ran: true, approved: verdict.approved, reason: verdict.reason, cost: result.costUsd ?? 0 };
  }

  private async dispatchPlanning(rt: IssueRuntime, issue: Issue): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    // Direction validation gate (§15) — blocks the issue if a Direction text is rejected.
    if (!(await this.runDirectionCheck(rt, issue, handle))) return;
    if (this.config.spec_mode === 'split') {
      await this.runSpecStage(rt, issue, handle, 'requirements');
      return;
    }
    const draft = await this.dispatch(rt, issue, kickoffPrompt(issue), false, 'planning', [SCRATCH.pendingPlan]);
    if (!draft.ok) return;
    if (await this.handleQuestion(rt, handle)) return;
    if (!(await this.readOutput(handle, SCRATCH.pendingPlan))) {
      await this.surfaceStuck(rt, 'Plan draft (.corral/pending_plan.md) is empty — please retry.');
      return;
    }
    await this.vetAndSendPlan(rt, issue, handle);
  }

  /** Plan vetting: critics over the draft → consolidate → send approval card. */
  /**
   * `resume` is set only by `resumeVetting()` — the restart-recovery path. A fresh cycle and
   * a human-requested re-vet both start over; a run the core interrupted picks up where it
   * left off instead of paying for finished rounds again (CRL-87).
   */
  private async vetAndSendPlan(
    rt: IssueRuntime,
    issue: Issue,
    handle: WorkspaceHandle,
    focus?: string,
    resume = false,
  ): Promise<void> {
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
      this.buildDirection(),
      resume,
    );
    // Preserve the draft — consolidation rewrites pending_plan.md from scratch.
    await this.workspace.io.exec(handle, `cp ${SCRATCH.pendingPlan} ${SCRATCH.planDraft} 2>/dev/null || true`);
    const consolidate = await this.dispatch(rt, issue, PROMPTS.consolidatePlan, true, 'planning', [
      SCRATCH.pendingPlan,
    ]);
    if (!consolidate.ok) return;
    await this.afterPlanProduced(rt, issue, 'plan');
  }

  /**
   * One spec stage: draft the document, vet it, then park on its approval gate.
   *
   * Deliberately the same shape as the single-plan flow above — draft, critique rounds,
   * consolidate, card — so the two modes do not drift into separate code paths. What
   * changes per stage is only which document is written and which card kind is raised.
   *
   * The spec files are never named in `produces`. A dispatch clears what it declares
   * (CRL-88), and these are the *input* of every later stage; the "did this turn produce
   * anything" check reads the file directly instead.
   */
  private async runSpecStage(
    rt: IssueRuntime,
    issue: Issue,
    handle: WorkspaceHandle,
    stage: SpecStage,
  ): Promise<void> {
    const log = logger.child(rt.identifier);
    const doc = specDoc(stage);
    rt.specStage = stage;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'plan_reviewing', label: `📐 Drafting ${stage}` });

    // First stage only: a fresh session. The later ones continue so the agent still has the
    // repository it just inspected, and they read the approved documents off disk anyway.
    // Clear the previous stage's options: the file is not stage-scoped, and a leftover
    // would answer for a stage that never wrote one (the same staleness CRL-87 fixed for
    // critique files).
    await this.workspace.io.writeFile(handle, SCRATCH.planOptions, '');
    const fresh = stage === 'requirements';
    const draft = await this.dispatch(rt, issue, specStagePrompt(issue, stage), !fresh, 'planning');
    if (!draft.ok) return;
    if (await this.handleQuestion(rt, handle)) return;
    if (!(await this.readOutput(handle, doc))) {
      await this.surfaceStuck(rt, `The ${stage} document (${doc}) is empty — please retry.`, true);
      return;
    }
    await this.vetAndSendSpec(rt, issue, handle, stage);
    log.info(`spec stage ${stage} awaiting approval`);
  }

  /** Critique + consolidate one spec document, then raise its approval card. */
  private async vetAndSendSpec(
    rt: IssueRuntime,
    issue: Issue,
    handle: WorkspaceHandle,
    stage: SpecStage,
    resume = false,
  ): Promise<void> {
    const doc = specDoc(stage);
    rt.phase = 'plan_reviewing';
    rt.specStage = stage;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'plan_reviewing', label: `🔍 Vetting ${stage}` });

    await this.planCritique.run(
      handle,
      issue,
      this.planningModel(),
      this.referencePath(),
      (r) => this.cost.add(rt.identifier, r),
      undefined,
      this.buildDirection(),
      resume,
      doc,
    );
    // Same guard the single flow uses: consolidation rewrites the document, so keep a copy
    // to fall back on if the turn produces nothing.
    await this.workspace.io.exec(handle, `cp ${doc} ${SCRATCH.planDraft} 2>/dev/null || true`);
    const consolidate = await this.dispatch(rt, issue, consolidateSpecPrompt(stage), true, 'planning');
    if (!consolidate.ok) return;
    await this.workspace.io.exec(handle, `test -s ${doc} || cp ${SCRATCH.planDraft} ${doc} 2>/dev/null || true`);

    const body = await this.readOutput(handle, doc);
    if (!body) {
      await this.surfaceStuck(rt, `The ${stage} document (${doc}) is empty after consolidation — please retry.`, true);
      return;
    }
    const phase = `${stage}_sent` as IssuePhase;
    rt.approvalId = await this.channel.sendApproval({
      identifier: rt.identifier,
      kind: stage,
      title: issue.title,
      body,
      // Only the design stage is told to write options (guide A2); requirements and tasks
      // are not. Attaching them everywhere meant the task card offered the design
      // alternatives again — a choice the human already made, presented as still open, and
      // carried into the implementation prompt as "Implement the X option" (CRL-113).
      options: stage === 'design' ? await this.planOptionsFor(handle) : undefined,
    });
    rt.phase = phase;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase, label: `🔔 Action needed — review the ${stage}` });
    await this.tracker.transitionIssue(issue, 'plan_review').catch(() => {});
  }

  /**
   * A spec gate was approved: run the next stage, or start implementing after the last one.
   *
   * `specStage` is cleared on the way into implementation — from there on the run is no
   * longer inside the planning ladder, and a stale value would make a later restart try to
   * resume vetting a stage that is already approved.
   */
  private async specGateApproved(rt: IssueRuntime, issue: Issue, detail?: ApprovalDetail): Promise<void> {
    const handle = this.handles.get(rt.identifier)!;
    const stage = (rt.specStage ?? 'requirements') as SpecStage;
    const next = nextSpecStage(stage);
    if (next) {
      await this.runSpecStage(rt, issue, handle, next);
      return;
    }
    rt.specStage = undefined;
    this.store.upsert(rt);
    await this.implementAndReview(rt, issue, detail);
  }

  /** Resume plan vetting interrupted by a restart (phase stuck at plan_reviewing). */
  private async resumeVetting(rt: IssueRuntime, handle: WorkspaceHandle): Promise<void> {
    const issue = await this.tracker.fetchIssueByIdentifier(rt.identifier).catch(() => null);
    if (!issue) return;
    // `plan_reviewing` is shared by both modes; `specStage` is what says which document was
    // being vetted. Absent means the single-plan flow — including every state file written
    // before spec mode existed (plan doc §10).
    const stage = rt.specStage as SpecStage | undefined;
    const doc = stage ? specDoc(stage) : SCRATCH.pendingPlan;
    await this.workspace.io.exec(
      handle,
      `test -s ${doc} || cp ${SCRATCH.planDraft} ${doc} 2>/dev/null || true`,
    );
    if (!(await this.readOutput(handle, doc))) {
      await this.surfaceStuck(rt, `Failed to resume ${stage ?? 'plan'} vetting — no draft left. Restart the issue.`);
      return;
    }
    // Say which rounds survived. A restart that reuses them and a restart that re-runs them
    // look the same on screen otherwise, and telling them apart is the point (CRL-87).
    const kept = (await this.workspace.io.list(handle, SCRATCH_DIR)).filter((n) => /^plan_critique_\d+\.md$/.test(n));
    bus.emitEvent({
      identifier: rt.identifier,
      kind: 'notice',
      label:
        kept.length > 0
          ? `↻ Auto-resuming interrupted plan vetting — reusing ${kept.length} finished critique round(s)`
          : '↻ Auto-resuming interrupted plan vetting',
    });
    void this.serialize(rt.identifier, () =>
      (stage
        ? this.vetAndSendSpec(rt, issue, handle, stage, true)
        : this.vetAndSendPlan(rt, issue, handle, undefined, true)
      ).catch((err) => {
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

  /**
   * Read-only Q&A about a pending result (plan/review). Dispatches a side turn against the
   * live workspace — the agent re-reads the code to give a grounded answer — WITHOUT
   * touching the result document or the issue's phase. The answer is reconstructed from the
   * agent's streamed text (no file write), and the API path is restricted to read tools.
   * Available only while the action is pending (the workspace clone is still alive).
   */
  async answerQuestion(identifier: string, question: string): Promise<{ ok: boolean; answer?: string; answerHtml?: string; message?: string }> {
    const rt = this.store.get(identifier);
    if (!rt) return { ok: false, message: 'Not an in-flight issue.' };
    if (!question.trim()) return { ok: false, message: 'Enter a question.' };
    const handle = this.handles.get(identifier);
    if (!handle) return { ok: false, message: 'Workspace closed — questions are only available while the action is pending.' };
    if (this.busy.has(identifier)) return { ok: false, message: 'The agent is busy — try again in a moment.' };
    const issue = await this.tracker.fetchIssueByIdentifier(identifier).catch(() => null);
    if (!issue) return { ok: false, message: 'Issue not found.' };
    const isReview = rt.phase.includes('review');
    const doc = (await this.readOutput(handle, isReview ? SCRATCH.pendingReview : SCRATCH.pendingPlan)) ?? '';
    const prompt = questionPrompt(isReview ? 'review' : 'plan', doc, question.trim());

    // The agent writes its answer as structured markdown to a file (line breaks + sections
    // survive there — the streamed timeline text is collapsed to one line). Clear it first
    // so a failed turn can't surface a stale answer; keep the streamed text as a fallback.
    await this.workspace.io.writeFile(handle, SCRATCH.qaAnswer, '').catch(() => {});
    const TEXT_PREFIX = '💬 ';
    const parts: string[] = [];
    const unsub = bus.subscribe((e) => {
      if (e.identifier === identifier && e.kind === 'activity' && e.label.startsWith(TEXT_PREFIX)) {
        parts.push(e.label.slice(TEXT_PREFIX.length));
      }
    });
    this.busy.add(identifier);
    try {
      const a = this.config.agent;
      const res = await this.agent.run(handle, issue, {
        stage: isReview ? 'review' : 'planning',
        workflow: '', // side run — don't overwrite the guide or wipe the result
        prompt,
        continueSession: true,
        turnTimeoutMs: a.turn_timeout_ms,
        maxTurns: a.max_turns,
        // read-only except the single answer file (enforced on the api transport; prompt-gated on cli)
        allowedTools: ['read', 'ls', 'grep', 'write'],
      });
      const fileAnswer = ((await this.readOutput(handle, SCRATCH.qaAnswer)) ?? '').trim();
      const answer = fileAnswer || parts.join('').trim();
      if (!res.ok && !answer) return { ok: false, message: 'The agent could not answer — try rephrasing.' };
      const final = answer || '(no answer)';
      // Persist the exchange (issues.json survives restarts; flushed into history on archive).
      rt.qa = [...(rt.qa ?? []), { q: question.trim(), a: final, ts: Date.now(), phase: isReview ? 'review' : 'plan' }];
      this.store.upsert(rt);
      return { ok: true, answer: final, answerHtml: renderMarkdown(final) };
    } finally {
      this.busy.delete(identifier);
      unsub();
    }
  }

  // ───────────────────────────────────────────────────── dispatch helper

  /** The provider that can't execute under the current backend for `stage`, or null.
   *  A stage routed to one is cancelled at dispatch (it may be *configured*, just not
   *  runnable). Fallbacks are for capacity exhaustion, not backend incompatibility, so
   *  only the stage's own routing counts.
   *
   *  Provider AND transport come from the same place, the way bootstrap resolves it: a
   *  stage override replaces the routing whole, so reading the provider from the override
   *  and the transport from the base would judge a pair that never runs. */
  private unrunnableStageProvider(stage: AgentStage): string | null {
    const routing = this.config.agent.stages?.[stage] ?? this.config.agent;
    return unrunnableProvider(routing, this.config.workspace.backend);
  }

  private async dispatch(
    rt: IssueRuntime,
    issue: Issue,
    prompt: string,
    continueSession: boolean,
    stage: AgentStage,
    /**
     * The human-facing files this turn is expected to write. They are blanked first, so a
     * turn that produces nothing is distinguishable from one that leaves the previous
     * cycle's file in place.
     *
     * Empty by default, and most turns leave it empty: `pending_plan.md` and
     * `pending_review.md` are *inputs* to the implementation, fix and feedback turns, and
     * clearing an input is never right. It used to happen on every dispatch (CRL-88).
     */
    produces: readonly string[] = [],
  ): Promise<AgentRunResult> {
    const handle = this.handles.get(rt.identifier);
    if (!handle) throw new Error(`no workspace handle for ${rt.identifier}`);

    if (this.busy.has(rt.identifier)) {
      logger.child(rt.identifier).warn('dispatch requested while busy; skipping');
      return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'crashed' };
    }
    // Checked before the turn, not after — a ceiling enforced afterwards has already
    // been exceeded. The agent is never reached, so failover never sees this and does
    // not waste an attempt on a second provider that shares the same limit.
    const allowed = this.budget?.check();
    if (allowed && !allowed.ok) {
      logger.child(rt.identifier).warn(`dispatch blocked: ${allowed.reason}`);
      bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: `⛔ ${allowed.reason}` });
      return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'budget' };
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
        direction: this.buildDirection(),
      });
      await wipeProduced(this.workspace.io, handle, produces);
      // Run-time backend guard: a provider assigned to this stage that can't execute under
      // the current backend (gemini under docker) is cancelled here with a clear message,
      // instead of failing cryptically mid-build. Configurable in setup, blocked at run.
      const blocked = this.unrunnableStageProvider(stage);
      if (blocked) {
        // Names the transport, because that is what makes it impossible — and it is the
        // cheapest of the three ways out (the container needs no gemini login on `api`).
        const msg = `${blocked}는 Docker 백엔드에서 CLI로 실행할 수 없습니다 — 이 단계를 API 트랜스포트로 바꾸거나, 다른 provider로 배치하거나, 워크스페이스를 로컬로 바꾸세요.`;
        rt.phase = 'auth_error_waiting';
        rt.stuck = true;
        this.store.upsert(rt);
        bus.emitEvent({ identifier: rt.identifier, kind: 'error', phase: rt.phase, label: `❌ ${msg}` });
        await this.channel.notify(rt.identifier, `❌ ${msg}`);
        return { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, exitCode: null, error: 'incompatible' };
      }
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
      if (result.error === 'login_required') {
        // A missing/invalid credential — a SETUP problem, not exhausted capacity. We do
        // NOT silently fail over to another provider; surface it so the user fixes auth.
        rt.phase = 'auth_error_waiting';
        this.store.upsert(rt);
        bus.emitEvent({ identifier: rt.identifier, kind: 'error', label: this.loginHelp() });
        await this.channel.notify(rt.identifier, this.loginHelp());
      } else if (result.error === 'auth') {
        // Reached only when every configured agent (primary + fallbacks) ended/expired.
        rt.phase = 'auth_error_waiting';
        this.store.upsert(rt);
        await this.channel.notify(
          rt.identifier,
          'Agent authentication expired mid-run (session/account ended). Re-authenticate on the host, then let us know.',
        );
      } else if (result.error === 'rate_limit') {
        // Every agent is out of capacity for now; the run is retryable once a limit resets.
        await this.channel.notify(
          rt.identifier,
          'All configured agents are out of usage capacity. Retry after a limit resets, or add another fallback agent.',
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
      requirements_sent: '✅ Requirements approved — drafting the design.',
      design_sent: '✅ Design approved — breaking it into tasks.',
      tasks_sent: '✅ Tasks approved — starting implementation.',
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
      case 'requirements_sent':
      case 'design_sent':
      case 'tasks_sent':
        await this.specGateApproved(rt, issue, detail);
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
      const stage = rt.specStage as SpecStage | undefined;
      if (stage) {
        // A spec stage asked the question, so the answer belongs to that stage — the guide
        // tells the agent to write a question instead of the document when it needs a
        // decision, and that happens (it did on the first measured A1 run). Routing the
        // answer through the single-plan path instead left the reply, and the turn it
        // bought, going to `pending_plan.md`, which does not exist in split mode: the run
        // stopped with "Plan file is empty" (CRL-113).
        const answered = await this.dispatch(rt, issue, text, true, 'planning');
        if (answered.ok) await this.vetAndSendSpec(rt, issue, this.handles.get(rt.identifier)!, stage);
        return;
      }
      const result = await this.dispatch(rt, issue, text, true, 'planning', [SCRATCH.pendingPlan]);
      if (result.ok) await this.afterPlanProduced(rt, issue, 'plan');
      return;
    }

    const signal = this.signals.feedback(text);
    const specGate = SPEC_GATE_PHASE[rt.phase];
    if (specGate) {
      // Revises the spec document in place, so — like plan feedback — the turn declares no
      // outputs: asking an agent to revise a file that was just blanked is not a revision.
      const result = await this.dispatch(rt, issue, signal, true, 'planning');
      if (result.ok) await this.resendApproval(rt, issue, specGate, specDoc(specGate));
      return;
    }
    if (rt.phase === 'plan_sent' || rt.phase === 'pr_plan_sent') {
      // Revises the existing plan in place (WORKFLOW.md branch B), so it must survive.
      // The cost: if the agent edits nothing, the unchanged plan goes back to the human
      // as though it were a revision. Better than asking it to revise a blank file.
      const result = await this.dispatch(rt, issue, signal, true, 'planning');
      if (result.ok) await this.resendApproval(rt, issue, rt.phase === 'plan_sent' ? 'plan' : 'pr_plan', SCRATCH.pendingPlan);
    } else if (rt.phase === 'review_sent') {
      // Manual review flow: the human's text drives the next step. The agent applies the
      // instruction — editing + committing code if asked — then we re-review ONCE and
      // present again (clean → PR, findings → card). No automatic fix→re-review loop.
      this.clearApproval(rt);
      // Declares pending_plan.md because this turn is the one place a *fix plan* is born:
      // asked to plan the fixes rather than apply them, the agent writes one here, and
      // `recoverPendingApproval` reads it back after a restart. That read only tells a fix
      // plan from the original implementation plan because this turn blanks the file first.
      // It consumes pending_review.md, so that one is left alone.
      const result = await this.dispatch(rt, issue, signal, true, 'implementation', [SCRATCH.pendingPlan]);
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

    if (this.config.spec_mode === 'split' && (await this.runTaskLoop(rt, issue))) return;

    // Reads the approved pending_plan.md (WORKFLOW.md branch C) — produces no card file.
    const impl = await this.dispatch(rt, issue, this.planApprovalPrompt(detail), true, 'implementation');
    if (!impl.ok) return;
    await this.reviewAfterImplement(rt, issue);
  }

  /**
   * Work `tasks.md` one task per turn, resuming wherever the file says the work stopped.
   *
   * Returns false when there is no readable task list, so the caller falls back to the
   * single implementation dispatch — the plan doc's mitigation for the parser breaking on
   * a format drift (§13). Every other outcome is handled here.
   *
   * The file is re-read every round rather than tracked in memory. That is the whole
   * mechanism behind "restart resumes from the remaining tasks": there is no state to
   * lose, so a restart that lands mid-list simply reads the ticks that are already there.
   */
  private async runTaskLoop(rt: IssueRuntime, issue: Issue): Promise<boolean> {
    const log = logger.child(rt.identifier);
    const handle = this.handles.get(rt.identifier)!;
    const state: TaskLoopState = { rounds: 0 };
    const announced = new Set<string>();
    const unbacked: TaskEvidence[] = [];

    for (;;) {
      const tasks = parseSpecTasks(await this.workspace.io.readFile(handle, SPEC.tasks));
      // Said once each, not per round — the same warning every turn would bury the events
      // that matter. Surfaced at all because a progress bar over a partly-unreadable file
      // is the misreading CRL-105 exists to prevent.
      for (const w of tasks?.warnings ?? []) {
        if (announced.has(w)) continue;
        announced.add(w);
        bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: `⚠️ tasks.md — ${w}` });
      }

      // Recorded here rather than read on demand: the dashboard polls, and re-reading the
      // file per issue per poll would put file I/O on that path. The loop is already
      // holding the parse (CRL-107).
      rt.taskProgress = tasks ? { done: tasks.done, total: tasks.total, warnings: tasks.warnings.length } : undefined;
      this.store.upsert(rt);

      const step = nextTaskStep(tasks, state, this.config.max_task_rounds);
      switch (step.kind) {
        case 'downgrade':
          this.clearTaskProgress(rt);
          log.warn(`task loop unavailable (${step.reason}) — falling back to a single implementation turn`);
          bus.emitEvent({
            identifier: rt.identifier,
            kind: 'notice',
            label: `↩︎ No task list to work from (${step.reason}) — implementing in one turn`,
          });
          return false;

        case 'halt':
          await this.surfaceStuck(rt, `Task loop stopped: ${step.reason}`, true);
          return true;

        case 'done':
          bus.emitEvent({ identifier: rt.identifier, kind: 'notice', label: `✅ All ${tasks!.total} task(s) complete` });
          // Said again, together, before the run moves on. The per-task notice scrolls away
          // during a long implementation; this is the last point where a person sees it
          // before a PR is proposed.
          if (unbacked.length > 0) {
            await this.channel.notify(
              rt.identifier,
              `⚠️ ${unbacked.length} task(s) marked done with no commit behind them: ${unbacked
                .map((e) => `${e.taskId} (${e.detail})`)
                .join('; ')}`,
            );
          }
          this.clearTaskProgress(rt);
          await this.reviewAfterImplement(rt, issue);
          return true;

        case 'run': {
          const task = tasks!.next!;
          bus.emitEvent({
            identifier: rt.identifier,
            kind: 'phase',
            phase: 'implementing',
            label: `🛠 ${task.id} (${step.position}/${step.total}) — ${task.title.slice(0, 60)}`,
          });
          // Bracket the turn so the tick can be checked against the repositories after it.
          // The tick lives outside git, so a commit is real evidence rather than a
          // by-product of writing the claim (CRL-109).
          const before = await this.repoHeads(handle);
          // Declares nothing: every later task reads the same three spec documents, and a
          // turn that cleared them would take the next task's input with it (CRL-88).
          const run = await this.dispatch(rt, issue, taskPrompt(task, step.position, step.total), true, 'implementation');
          if (!run.ok) return true; // dispatch already surfaced why; the ticks so far survive
          const after = await this.repoHeads(handle);

          const ticked = parseSpecTasks(await this.workspace.io.readFile(handle, SPEC.tasks));
          const claimed = ticked?.tasks.find((t) => t.id === task.id)?.done ?? false;
          const evidence = taskEvidence(task.id, claimed, before, after);
          if (isUnbacked(evidence)) {
            // Not a halt: a task can legitimately need no change — already done, or covered
            // in passing by an earlier one. Stopping the run on that would repeat the
            // mistake CRL-105 avoided with missing dependencies. But it is said out loud,
            // because silence here is exactly the CRL-89 failure.
            unbacked.push(evidence);
            bus.emitEvent({
              identifier: rt.identifier,
              kind: 'notice',
              label: `⚠️ ${task.id} is ticked but no repository changed (${evidence.detail})`,
            });
          }

          state.lastTaskId = task.id;
          state.rounds += 1;
          break;
        }
      }
    }
  }

  /**
   * The three spec documents for an issue, rendered.
   *
   * The approval card is gone once it is approved, and these are what was approved — the
   * only record of the requirements a reviewer would want to check a PR against. Rendered
   * here because the core owns the markdown parser; putting one in the window would copy
   * a responsibility that deliberately lives on this side.
   */
  async specDocs(identifier: string): Promise<Array<{ stage: SpecStage; markdown: string; html: string }>> {
    const handle = this.handles.get(identifier);
    if (!handle) return [];
    const out: Array<{ stage: SpecStage; markdown: string; html: string }> = [];
    for (const stage of SPEC_STAGES) {
      const markdown = await this.workspace.io.readFile(handle, specDoc(stage)).catch(() => null);
      // A stage that has not run yet simply has no document; an empty entry would render as
      // an empty tab and read as "there is nothing to say here", which is different.
      if (markdown?.trim()) out.push({ stage, markdown, html: renderMarkdown(markdown) });
    }
    return out;
  }

  /** Drop the counts once the loop is done, so a later cycle cannot show yesterday's. */
  private clearTaskProgress(rt: IssueRuntime): void {
    if (!rt.taskProgress) return;
    rt.taskProgress = undefined;
    this.store.upsert(rt);
  }

  /**
   * `HEAD` per repo, for bracketing a task turn.
   *
   * A repo that cannot be read comes back as `null` rather than an empty string, so the
   * comparison can leave it out instead of reading a failed `git` call as "unchanged".
   */
  private async repoHeads(handle: WorkspaceHandle): Promise<RepoHeads> {
    const heads: RepoHeads = {};
    for (const repo of this.router.all()) {
      try {
        const out = await this.workspace.io.exec(handle, `git -C ${repo.key} rev-parse HEAD`);
        heads[repo.key] = out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
      } catch {
        heads[repo.key] = null;
      }
    }
    return heads;
  }

  /** Resume an implement / review-fix run that a restart interrupted (continue the session). */
  private async resumeImplementing(rt: IssueRuntime, issue: Issue): Promise<void> {
    rt.phase = 'implementing';
    rt.stuck = false;
    this.store.upsert(rt);
    bus.emitEvent({ identifier: rt.identifier, kind: 'phase', phase: 'implementing', label: '🛠 Resuming implementation (interrupted run)' });
    await this.tracker.transitionIssue(issue, 'in_progress').catch(() => {});

    // In spec mode the task file already says where the work stopped, so the resume is just
    // the loop again — no prompt about "continuing" and no memory of what came before.
    if (this.config.spec_mode === 'split' && (await this.runTaskLoop(rt, issue))) return;

    // A plain resume left the agent re-deriving what it had already done — six minutes of
    // it, in the measured run. If the last check saw edits with no commit, say so up front
    // so the first move is the commit (CRL-91).
    const resume = rt.uncommitted
      ? `${this.signals.resume} ${this.profile.t('signal.resumeUncommitted')}`
      : this.signals.resume;
    const impl = await this.dispatch(rt, issue, resume, true, 'implementation');
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
      // `git diff base..HEAD` cannot see a work tree, so "no committed diff" covers two
      // very different situations: the agent did nothing, or it did everything and never
      // committed. Look before saying which — the operator's next move differs, and the
      // wrong sentence has already cost a 4.35M-token turn (CRL-91).
      const dirty = await uncommittedAcross(this.workspace.io, handle, this.router.all().map((r) => r.key));
      rt.uncommitted = dirty.length > 0;
      this.store.upsert(rt);
      log.error(`no committed diff in any repo after implementation (uncommitted repos: ${dirty.length})`);
      // Retryable either way: retry resumes implementation and re-checks.
      await this.surfaceStuck(
        rt,
        dirty.length > 0
          ? `${this.profile.t('stuck.uncommitted')} ${describeUncommitted(dirty)}`
          : this.profile.t('stuck.noChanges'),
        true,
      );
      return;
    }
    // A commit exists, so the earlier "edited but never committed" reading is spent. Left
    // set, it would keep prepending the commit-first nudge to every later resume.
    if (rt.uncommitted) {
      rt.uncommitted = false;
      this.store.upsert(rt);
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
    const unmet = unmetCriteria(status);
    if (unmet > 0) {
      // The one place this layer has teeth. Everything else can be quiet and a requirement
      // the plan committed to is still missing — shipping that unseen is what writing the
      // criteria down was meant to prevent.
      bus.emitEvent({
        identifier: rt.identifier,
        kind: 'notice',
        label: `📋 ${unmet} of ${status!.criteria!.total} acceptance criteria unmet — needs a human`,
      });
    }
    if (isReviewClean(status) && this.config.review.auto_pr_when_clean) {
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
      // Written to the runtime, not only announced. The event has always gone out — which
      // is why the history timeline knew about the review — but the dashboard reads
      // `snapshot()`, which reads this, and so it said `implementing` for the whole run
      // (CRL-90). Re-set each round so a re-review after an auto-fix is covered too.
      rt.phase = 'reviewing';
      // A retry after a restart enters here; the run is moving again, so it is no longer
      // stuck. Every other resume path clears its own flag the same way.
      rt.stuck = false;
      this.store.upsert(rt);
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
        this.buildDirection(),
        // In split mode the criteria live in requirements.md, not the single plan. CRL-99's
        // escape hatch covers the rest: no REQ ids found, no criteria section.
        this.config.spec_mode === 'split' ? SPEC.requirements : undefined,
      );
      await this.uploadDiff(rt, issue, changed);
      const consolidate = await this.dispatch(rt, issue, PROMPTS.consolidateReview, true, 'review', [
        SCRATCH.pendingReview,
      ]);
      if (!consolidate.ok) return null;
      const review = await this.readOutput(handle, SCRATCH.pendingReview);
      if (!review) {
        log.warn('no pending_review.md after consolidation');
        return null;
      }
      await this.workspace.io.writeFile(handle, SCRATCH.prevReview, review);

      const status = await this.reviewStatus(handle);
      // Unmet criteria count as fixable: they mean code is missing, and the fix turn reads
      // the `## Acceptance criteria` section of pending_review.md that names which.
      const fixable = fixableCount(status);
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
        label: `🔧 Auto-fixing review findings (BLOCKER ${status?.blocker ?? 0}, SUG ${status?.suggestion ?? 0}${
          unmetCriteria(status) > 0 ? `, UNMET ${unmetCriteria(status)}` : ''
        })`,
      });
      // Reads the findings in pending_review.md — produces no card file.
      const fix = await this.dispatch(rt, issue, PROMPTS.applyReviewFixes, true, 'implementation');
      if (!fix.ok) return null;
    }
  }

  private async reviewStatus(handle: WorkspaceHandle): Promise<ReviewStatus | null> {
    return parseReviewStatus(await this.workspace.io.readFile(handle, SCRATCH.reviewStatus));
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
    this.archive(rt, 'completed');
    this.cost.clear(identifier);
    this.store.delete(identifier);
    this.limiter.release(identifier);
    log.info('issue completed; workspace cleaned up');
  }

  /**
   * Whether planning runs as three spec gates or one plan.
   *
   * The dashboard needs it, not just the flow: the phase bar shows three approval stages in
   * split mode, and deriving that from the current phase would make the bar collapse from
   * three stages back to one the moment the gates are passed — losing the reader's place
   * exactly when the long part of the run starts (CRL-104).
   */
  get specMode(): 'single' | 'split' {
    return this.config.spec_mode;
  }

  /** Snapshot for the dashboard: each tracked issue + its accumulated cost. */
  snapshot(): Array<IssueRuntime & { cost: number }> {
    return this.store.all().map((rt) => ({ ...rt, cost: this.cost.get(rt.identifier)?.costUsd ?? 0 }));
  }

  /** Past issue runs (completed/removed/failed), newest first. Tracker-independent. */
  listHistory(opts?: { limit?: number; offset?: number; outcome?: IssueOutcome }): HistoryRecord[] {
    return this.history.list(opts);
  }

  /** Most recent history record for one identifier (or undefined). */
  getHistory(identifier: string): HistoryRecord | undefined {
    return this.history.get(identifier);
  }

  // ─────────────────────────────────────────────────────────── helpers

  private async resendApproval(
    rt: IssueRuntime,
    issue: Issue,
    kind: 'plan' | 'review' | 'pr_plan' | SpecStage,
    file: string,
  ): Promise<void> {
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
      // Same rule as the first send: only the kinds whose branch writes the file get
      // options, so a revised task list does not re-offer the design's alternatives.
      options: kind === 'plan' || kind === 'design' ? await this.planOptionsFor(handle) : undefined,
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
/** Phases whose awaited step `redispatchPhase` can re-run in place (others need a Restart). */
/** Approval phase → the spec stage whose document it gates. */
const SPEC_GATE_PHASE: Record<string, SpecStage | undefined> = {
  requirements_sent: 'requirements',
  design_sent: 'design',
  tasks_sent: 'tasks',
};

const RETRYABLE_PHASES = new Set<string>([
  'plan_sent',
  'pr_plan_sent',
  'requirements_sent',
  'design_sent',
  'tasks_sent',
  'review_sent',
  'implementing',
  'reviewing',
  'review_fixing',
]);

function oneLineErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Prompt for a read-only clarification turn about a pending plan/review. The answer is
 *  written to a file (SCRATCH.qaAnswer) as structured markdown so line breaks and sections
 *  survive — the live timeline collapses streamed text to one line, which is unreadable. */
function questionPrompt(kind: 'plan' | 'review', doc: string, question: string): string {
  return [
    `The human is reading your ${kind} for this issue and has a QUESTION about it.`,
    `Ground your answer in the actual code — read the files you need to be precise — and the ${kind} document below.`,
    '',
    `WRITE YOUR ANSWER as markdown to \`${SCRATCH.qaAnswer}\`. Do NOT modify, create, stage, or commit ANY other file, and do NOT change the ${kind}. The only file you may write is \`${SCRATCH.qaAnswer}\`.`,
    'Format the answer to be scannable — never one dense paragraph:',
    '- Open with a one or two sentence direct answer (a `## 요약` / `## Summary` section).',
    '- Then break the reasoning into short bullets or `###` subsections, one point each.',
    '- Put a blank line between blocks. Keep code identifiers and file paths in `code` style.',
    'Write in the same language as the document.',
    '',
    `=== YOUR ${kind.toUpperCase()} ===`,
    doc || '(document unavailable — answer from the code)',
    '',
    '=== QUESTION ===',
    question,
  ].join('\n');
}

/** Single-quote a string for safe interpolation into a shell command (repo keys can
 * contain spaces/special chars). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
