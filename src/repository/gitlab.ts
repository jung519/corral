/**
 * GitLab repository — REST v4 (merge requests). Auth: personal access token
 * (PRIVATE-TOKEN). Supports self-hosted via `host`. Normalizes MRs into the
 * tracker-neutral PullRequest model (MR iid → PullRequest.number).
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

type GitlabConfig = Extract<RepositoryConfig, { kind: 'gitlab' }>;

const MrSchema = z
  .object({
    iid: z.number(),
    web_url: z.string(),
    title: z.string(),
    state: z.string(), // opened | merged | closed | locked
    source_branch: z.string(),
    target_branch: z.string(),
  })
  .passthrough();

const NoteSchema = z
  .object({
    id: z.number(),
    author: z.object({ username: z.string() }).nullable().optional(),
    body: z.string().nullable(),
    created_at: z.string(),
    system: z.boolean().optional(),
  })
  .passthrough();

export class GitlabRepository implements RepositoryAdapter {
  readonly kind = 'gitlab';
  readonly key: string;
  readonly description: string;
  readonly workerImage?: string;
  readonly verifyCommands: string[];
  readonly afterClone?: string;
  private readonly api: string;
  private readonly pid: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly cfg: GitlabConfig,
    private readonly ctx: RepositoryCtx,
  ) {
    this.key = cfg.key;
    this.description = cfg.description;
    this.workerImage = cfg.image;
    this.verifyCommands = cfg.verify;
    this.afterClone = cfg.after_clone;
    this.api = `${cfg.host.replace(/\/$/, '')}/api/v4`;
    this.pid = encodeURIComponent(cfg.repo);
    this.headers = { 'PRIVATE-TOKEN': ctx.token, 'Content-Type': 'application/json' };
  }

  cloneUrl(): string {
    const host = this.cfg.host.replace(/^https?:\/\//, '');
    return `https://oauth2:${this.ctx.token}@${host}/${this.cfg.repo}.git`;
  }

  baseBranchFor = (issue: Issue): string =>
    issue.labels.some((l) => this.cfg.branch_strategy.hotfix_labels.includes(l))
      ? this.cfg.branch_strategy.production
      : this.cfg.branch_strategy.development;

  branchNameFor(issue: Issue): string {
    return `${this.cfg.branch_prefix}${issue.identifier}`;
  }

  private mrs(): string {
    return `${this.api}/projects/${this.pid}/merge_requests`;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const json = await fetchJson<unknown>(`${this.mrs()}?state=opened&per_page=100`, { headers: this.headers }, { label: 'gitlab.mrs' });
    return z.array(MrSchema).parse(json).map(toPullRequest);
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequest | null> {
    const json = await fetchJson<unknown>(
      `${this.mrs()}?state=opened&source_branch=${encodeURIComponent(branch)}`,
      { headers: this.headers },
      { label: 'gitlab.mrs.byBranch' },
    );
    const mrs = z.array(MrSchema).parse(json);
    return mrs.length > 0 ? toPullRequest(mrs[0]!) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const json = await fetchJson<unknown>(
      this.mrs(),
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ source_branch: input.head, target_branch: input.base, title: input.title, description: input.body }),
      },
      { label: 'gitlab.mr.create' },
    );
    return toPullRequest(MrSchema.parse(json));
  }

  async createPullRequestComment(pr: PullRequest, body: string): Promise<void> {
    await fetchRetry(
      `${this.mrs()}/${pr.number}/notes`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body }) },
      { label: 'gitlab.mr.note' },
    );
  }

  async fetchPullRequestComments(pr: PullRequest, since?: string): Promise<PullRequestComment[]> {
    const json = await fetchJson<unknown>(
      `${this.mrs()}/${pr.number}/notes?sort=asc&per_page=100`,
      { headers: this.headers },
      { label: 'gitlab.mr.notes' },
    );
    return z
      .array(NoteSchema)
      .parse(json)
      .filter((n) => !n.system && (!since || n.created_at > since))
      .map((n) => ({ id: String(n.id), author: n.author?.username ?? 'unknown', body: n.body ?? '', createdAt: n.created_at }));
  }

  async deleteBranch(branch: string): Promise<void> {
    await fetchRetry(
      `${this.api}/projects/${this.pid}/repository/branches/${encodeURIComponent(branch)}`,
      { method: 'DELETE', headers: this.headers },
      { label: 'gitlab.branch.delete', maxRetries: 1 },
    ).catch(() => {});
  }

  async refreshPullRequest(number: number): Promise<PullRequest | null> {
    try {
      const json = await fetchJson<unknown>(`${this.mrs()}/${number}`, { headers: this.headers }, { label: 'gitlab.mr' });
      return toPullRequest(MrSchema.parse(json));
    } catch {
      return null;
    }
  }
}

function toPullRequest(mr: z.infer<typeof MrSchema>): PullRequest {
  const merged = mr.state === 'merged';
  return {
    number: mr.iid,
    url: mr.web_url,
    title: mr.title,
    branch: mr.source_branch,
    baseBranch: mr.target_branch,
    state: merged ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
    merged,
  };
}
