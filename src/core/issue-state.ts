/**
 * Per-issue runtime state + persistence. Survives restarts so the orchestrator
 * can resume mid-flow (the recovery step cross-checks workspace + tracker state).
 * Stored in the orchestrator state dir (NOT the workspace, so it outlives cleanup).
 *
 * Lifted from upstream. Adaptations: state dir renamed `.symphony-state` →
 * `.corral-state` and made injectable (constructor arg / CORRAL_STATE_DIR) for
 * testability.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import type { IssuePhase } from './types.js';

export const DEFAULT_STATE_DIR = process.env.CORRAL_STATE_DIR ?? '.corral-state';

/** A pull request opened for one repo touched by the issue. */
export interface IssuePr {
  repoKey: string;
  number: number;
  branch: string;
  url?: string;
}

export interface IssueRuntime {
  identifier: string;
  /** Primary/hint repo key (display + routing hint); work may span several repos. */
  repoKey: string;
  phase: IssuePhase;
  /** For dashboard display. */
  title?: string;
  url?: string;
  /** Base commit per repo key, captured at clone — defines each repo's review diff. */
  baseCommits?: Record<string, string>;
  /** PRs opened for this issue, one per repo that changed. */
  prs?: IssuePr[];
  /** Last handled PR comment timestamp (ISO). */
  prSince?: string;
  /** Current pending approval id. */
  approvalId?: string;
  /**
   * Set when a restart interrupted an active phase (implementing/review_fixing)
   * and left it without a card. Surfaces the retry affordance so the run can be
   * resumed; cleared once a resume dispatch starts.
   */
  stuck?: boolean;
}

export class IssueStateStore {
  private byId = new Map<string, IssueRuntime>();
  private readonly stateDir: string;
  private readonly file: string;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    this.stateDir = stateDir;
    this.file = resolve(stateDir, 'issues.json');
    this.load();
  }

  get(identifier: string): IssueRuntime | undefined {
    return this.byId.get(identifier);
  }

  upsert(rt: IssueRuntime): void {
    this.byId.set(rt.identifier, rt);
    this.persist();
  }

  delete(identifier: string): void {
    this.byId.delete(identifier);
    this.persist();
  }

  all(): IssueRuntime[] {
    return [...this.byId.values()];
  }

  findByApprovalId(approvalId: string): IssueRuntime | undefined {
    return this.all().find((rt) => rt.approvalId === approvalId);
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, IssueRuntime>;
      this.byId = new Map(Object.entries(raw));
    } catch {
      /* none */
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byId), null, 2));
    } catch (err) {
      logger.warn('issue-state persist failed', String(err));
    }
  }
}
