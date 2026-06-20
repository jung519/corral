/**
 * Bitbucket Cloud repository — REST 2.0 (pull requests). Auth: username + app
 * password (Basic). Normalizes PRs into the tracker-neutral PullRequest model.
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
  token: string;
}

type BitbucketConfig = Extract<RepositoryConfig, { kind: 'bitbucket' }>;

const API = 'https://api.bitbucket.org/2.0';

const PrSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    state: z.string(), // OPEN | MERGED | DECLINED | SUPERSEDED
    links: z.object({ html: z.object({ href: z.string() }) }).passthrough(),
    source: z.object({ branch: z.object({ name: z.string() }) }).passthrough(),
    destination: z.object({ branch: z.object({ name: z.string() }) }).passthrough(),
  })
  .passthrough();

const CommentSchema = z
  .object({
    id: z.number(),
    user: z.object({ display_name: z.string() }).nullable().optional(),
    content: z.object({ raw: z.string().nullable() }).optional(),
    created_on: z.string(),
  })
  .passthrough();

const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ values: z.array(item).default([]) }).passthrough();

export class BitbucketRepository implements RepositoryAdapter {
  readonly kind = 'bitbucket';
  readonly key: string;
  readonly workerImage?: string;
  readonly verifyCommands: string[];
  readonly afterClone?: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly cfg: BitbucketConfig,
    private readonly ctx: RepositoryCtx,
  ) {
    this.key = cfg.key;
    this.workerImage = cfg.image;
    this.verifyCommands = cfg.verify;
    this.afterClone = cfg.after_clone;
    const basic = Buffer.from(`${cfg.username}:${ctx.token}`).toString('base64');
    this.headers = { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
  }

  cloneUrl(): string {
    return `https://${this.cfg.username}:${this.ctx.token}@bitbucket.org/${this.cfg.repo}.git`;
  }

  baseBranchFor = (issue: Issue): string =>
    issue.labels.some((l) => this.cfg.branch_strategy.hotfix_labels.includes(l))
      ? this.cfg.branch_strategy.production
      : this.cfg.branch_strategy.development;

  branchNameFor(issue: Issue): string {
    return `${this.cfg.branch_prefix}${issue.identifier}`;
  }

  private prs(): string {
    return `${API}/repositories/${this.cfg.repo}/pullrequests`;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const json = await fetchJson<unknown>(`${this.prs()}?state=OPEN&pagelen=50`, { headers: this.headers }, { label: 'bitbucket.prs' });
    return Page(PrSchema).parse(json).values.map(toPullRequest);
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequest | null> {
    const q = encodeURIComponent(`source.branch.name="${branch}" AND state="OPEN"`);
    const json = await fetchJson<unknown>(`${this.prs()}?q=${q}&pagelen=5`, { headers: this.headers }, { label: 'bitbucket.prs.byBranch' });
    const values = Page(PrSchema).parse(json).values;
    return values.length > 0 ? toPullRequest(values[0]!) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const json = await fetchJson<unknown>(
      this.prs(),
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source: { branch: { name: input.head } },
          destination: { branch: { name: input.base } },
        }),
      },
      { label: 'bitbucket.pr.create' },
    );
    return toPullRequest(PrSchema.parse(json));
  }

  async createPullRequestComment(pr: PullRequest, body: string): Promise<void> {
    await fetchRetry(
      `${this.prs()}/${pr.number}/comments`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ content: { raw: body } }) },
      { label: 'bitbucket.pr.comment' },
    );
  }

  async fetchPullRequestComments(pr: PullRequest, since?: string): Promise<PullRequestComment[]> {
    const json = await fetchJson<unknown>(
      `${this.prs()}/${pr.number}/comments?pagelen=50&sort=created_on`,
      { headers: this.headers },
      { label: 'bitbucket.pr.comments' },
    );
    return Page(CommentSchema)
      .parse(json)
      .values.filter((c) => !since || c.created_on > since)
      .map((c) => ({ id: String(c.id), author: c.user?.display_name ?? 'unknown', body: c.content?.raw ?? '', createdAt: c.created_on }));
  }

  async deleteBranch(branch: string): Promise<void> {
    await fetchRetry(
      `${API}/repositories/${this.cfg.repo}/refs/branches/${encodeURIComponent(branch)}`,
      { method: 'DELETE', headers: this.headers },
      { label: 'bitbucket.branch.delete', maxRetries: 1 },
    ).catch(() => {});
  }

  async refreshPullRequest(number: number): Promise<PullRequest | null> {
    try {
      const json = await fetchJson<unknown>(`${this.prs()}/${number}`, { headers: this.headers }, { label: 'bitbucket.pr' });
      return toPullRequest(PrSchema.parse(json));
    } catch {
      return null;
    }
  }
}

function toPullRequest(pr: z.infer<typeof PrSchema>): PullRequest {
  const merged = pr.state === 'MERGED';
  return {
    number: pr.id,
    url: pr.links.html.href,
    title: pr.title,
    branch: pr.source.branch.name,
    baseBranch: pr.destination.branch.name,
    state: merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
    merged,
  };
}
