/**
 * GitHub repository — REST v3. Normalizes GitHub responses into the
 * tracker-neutral PullRequest / PullRequestComment models.
 *
 * Lifted from upstream. Adaptation: the access token comes from the resolved
 * CredentialStore (ctx.token), not an inline config field.
 */
import { z } from 'zod';
import type { RepositoryConfig } from '../config/schema.js';
import { fetchJson, fetchRetry } from '../core/fetch-retry.js';
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

const API = 'https://api.github.com';

const PrSchema = z
  .object({
    number: z.number(),
    html_url: z.string(),
    title: z.string(),
    state: z.string(),
    merged_at: z.string().nullable().optional(),
    merged: z.boolean().optional(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  })
  .passthrough();

const CommentSchema = z
  .object({
    id: z.number(),
    user: z.object({ login: z.string() }).nullable(),
    body: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();

export class GithubRepository implements RepositoryAdapter {
  readonly kind = 'github';
  readonly key: string;
  readonly workerImage?: string;
  readonly verifyCommands: string[];
  readonly afterClone?: string;
  private readonly owner: string;
  private readonly repoName: string;
  private readonly token: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly cfg: GithubConfig,
    ctx: RepositoryCtx,
  ) {
    this.key = cfg.key;
    this.workerImage = cfg.image;
    this.verifyCommands = cfg.verify;
    this.afterClone = cfg.after_clone;
    this.token = ctx.token;
    const [owner, repoName] = cfg.repo.split('/');
    if (!owner || !repoName) throw new Error(`invalid github repo "${cfg.repo}" (expected owner/repo)`);
    this.owner = owner;
    this.repoName = repoName;
    this.headers = {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'corral',
    };
  }

  /** Authenticated clone URL (token embedded — never log verbatim). */
  cloneUrl(): string {
    return `https://x-access-token:${this.token}@github.com/${this.owner}/${this.repoName}.git`;
  }

  baseBranchFor = (issue: Issue): string => {
    const hotfix = this.cfg.branch_strategy.hotfix_labels;
    const isHotfix = issue.labels.some((l) => hotfix.includes(l));
    return isHotfix ? this.cfg.branch_strategy.production : this.cfg.branch_strategy.development;
  };

  branchNameFor(issue: Issue): string {
    return `${this.cfg.branch_prefix}${issue.identifier}`;
  }

  private base(): string {
    return `${API}/repos/${this.owner}/${this.repoName}`;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const json = await fetchJson<unknown>(
      `${this.base()}/pulls?state=open&per_page=100`,
      { headers: this.headers },
      { label: 'github.pulls' },
    );
    return z.array(PrSchema).parse(json).map(toPullRequest);
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequest | null> {
    // Only reuse an OPEN PR — a closed/merged one from a prior run must not be
    // resurrected (that masked a failed push as success).
    const json = await fetchJson<unknown>(
      `${this.base()}/pulls?state=open&head=${this.owner}:${encodeURIComponent(branch)}&per_page=10`,
      { headers: this.headers },
      { label: 'github.pulls.byBranch' },
    );
    const prs = z.array(PrSchema).parse(json);
    return prs.length > 0 ? toPullRequest(prs[0]!) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const json = await fetchJson<unknown>(
      `${this.base()}/pulls`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(input) },
      { label: 'github.pulls.create' },
    );
    return toPullRequest(PrSchema.parse(json));
  }

  async createPullRequestComment(pr: PullRequest, body: string): Promise<void> {
    // PR conversation comments use the issue-comments endpoint.
    await fetchRetry(
      `${this.base()}/issues/${pr.number}/comments`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body }) },
      { label: 'github.pr.comment.create' },
    );
  }

  async fetchPullRequestComments(pr: PullRequest, since?: string): Promise<PullRequestComment[]> {
    const params = new URLSearchParams({ per_page: '100' });
    if (since) params.set('since', since);
    const json = await fetchJson<unknown>(
      `${this.base()}/issues/${pr.number}/comments?${params.toString()}`,
      { headers: this.headers },
      { label: 'github.pr.comments' },
    );
    return z
      .array(CommentSchema)
      .parse(json)
      .map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
      }));
  }

  async deleteBranch(branch: string): Promise<void> {
    await fetchRetry(
      `${this.base()}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE', headers: this.headers },
      { label: 'github.branch.delete', maxRetries: 1 },
    ).catch(() => {
      /* branch may already be gone after merge */
    });
  }

  async refreshPullRequest(number: number): Promise<PullRequest | null> {
    try {
      const json = await fetchJson<unknown>(
        `${this.base()}/pulls/${number}`,
        { headers: this.headers },
        { label: 'github.pull' },
      );
      return toPullRequest(PrSchema.parse(json));
    } catch {
      return null;
    }
  }
}

function toPullRequest(pr: z.infer<typeof PrSchema>): PullRequest {
  const merged = pr.merged ?? pr.merged_at != null;
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    state: merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    merged,
  };
}
