/** GitHub repository — reference adapter. Pure, config-derived helpers (branch
 * names, clone URL) are real; network ops are lifted in S2. */
import type { RepositoryConfig } from '../config/schema.js';
import { notImplemented } from '../core/not-implemented.js';
import type {
  CreatePullRequestInput,
  Issue,
  PullRequest,
  PullRequestComment,
  RepositoryAdapter,
} from '../core/types.js';

export interface RepositoryCtx {
  /** Resolved access token (from the CredentialStore). */
  token: string;
}

type GithubConfig = Extract<RepositoryConfig, { kind: 'github' }>;

export class GithubRepository implements RepositoryAdapter {
  readonly kind = 'github';
  readonly key: string;
  readonly workerImage?: string;
  readonly verifyCommands: string[];
  readonly afterClone?: string;

  constructor(
    private readonly config: GithubConfig,
    private readonly ctx: RepositoryCtx,
  ) {
    this.key = config.key;
    this.workerImage = config.image;
    this.verifyCommands = config.verify;
    this.afterClone = config.after_clone;
  }

  readonly baseBranchFor = (_issue: Issue): string => this.config.branch_strategy.production;

  branchNameFor(issue: Issue): string {
    return `${this.config.branch_prefix}${issue.identifier}`;
  }

  cloneUrl(): string {
    return `https://x-access-token:${this.ctx.token}@github.com/${this.config.repo}.git`;
  }

  listOpenPullRequests(): Promise<PullRequest[]> {
    return notImplemented('github.listOpenPullRequests');
  }
  findPullRequestByBranch(): Promise<PullRequest | null> {
    return notImplemented('github.findPullRequestByBranch');
  }
  createPullRequest(_input: CreatePullRequestInput): Promise<PullRequest> {
    return notImplemented('github.createPullRequest');
  }
  fetchPullRequestComments(): Promise<PullRequestComment[]> {
    return notImplemented('github.fetchPullRequestComments');
  }
  createPullRequestComment(): Promise<void> {
    return notImplemented('github.createPullRequestComment');
  }
  deleteBranch(): Promise<void> {
    return notImplemented('github.deleteBranch');
  }
}
