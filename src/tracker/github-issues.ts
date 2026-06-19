/**
 * GitHub Issues tracker — implements TrackerAdapter over the GitHub REST API.
 * Notion is NOT required; this is a second reference tracker proving the axis is
 * pluggable (any API-accessible tracker can be added the same way).
 *
 * Mapping onto GitHub:
 *   semantic state ← issue labels (config `states`: state → label); closed = done
 *   identifier      ← `<identifier_prefix><number>` (e.g. issue-123)
 *   candidates      ← open issues, optionally gated by `scope_label`
 */
import { z } from 'zod';
import type { TrackerConfig } from '../config/schema.js';
import { fetchJson, fetchRetry } from '../core/fetch-retry.js';
import { logger } from '../core/logger.js';
import type { BotIdentity, Issue, IssueState, TrackerAdapter, TrackerComment } from '../core/types.js';

export interface TrackerCtx {
  token: string;
}

type GhConfig = Extract<TrackerConfig, { kind: 'github_issues' }>;

const API = 'https://api.github.com';

const LabelSchema = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);
const IssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    html_url: z.string().optional(),
    labels: z.array(LabelSchema).default([]),
    pull_request: z.unknown().optional(), // present → it's a PR, not an issue
  })
  .passthrough();
type RawIssue = z.infer<typeof IssueSchema>;

const CommentSchema = z
  .object({
    id: z.number(),
    user: z.object({ login: z.string() }).nullable(),
    body: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();

const ACTIVE: IssueState[] = ['planning', 'plan_review', 'in_progress', 'in_review'];

export class GithubIssuesTracker implements TrackerAdapter {
  readonly kind = 'github_issues';
  private readonly owner: string;
  private readonly repo: string;
  private readonly headers: Record<string, string>;
  /** label → semantic state (first mapping wins). */
  private readonly labelToState = new Map<string, IssueState>();

  constructor(
    private readonly cfg: GhConfig,
    ctx: TrackerCtx,
  ) {
    const [owner, repo] = cfg.repo.split('/');
    if (!owner || !repo) throw new Error(`invalid github repo "${cfg.repo}"`);
    this.owner = owner;
    this.repo = repo;
    this.headers = {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'corral',
    };
    for (const [semantic, label] of Object.entries(cfg.states)) {
      if (label && !this.labelToState.has(label)) this.labelToState.set(label, semantic as IssueState);
    }
  }

  private base(): string {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  private numberOf(issue: Issue): number {
    return Number(issue.internalId);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const params = new URLSearchParams({ state: 'open', per_page: '100' });
    if (this.cfg.scope_label) params.set('labels', this.cfg.scope_label);
    const json = await fetchJson<unknown>(
      `${this.base()}/issues?${params.toString()}`,
      { headers: this.headers },
      { label: 'github.issues' },
    );
    const issues = z.array(IssueSchema).parse(json);
    return issues
      .map((raw) => this.toIssue(raw))
      .filter((i): i is Issue => i !== null && ACTIVE.includes(i.state));
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const m = identifier.match(/(\d+)\s*$/);
    if (!m) return null;
    try {
      const json = await fetchJson<unknown>(
        `${this.base()}/issues/${m[1]}`,
        { headers: this.headers },
        { label: 'github.issue' },
      );
      return this.toIssue(IssueSchema.parse(json));
    } catch {
      return null;
    }
  }

  async transitionIssue(issue: Issue, to: IssueState): Promise<void> {
    const number = this.numberOf(issue);
    if (to === 'done' || to === 'canceled') {
      await this.patch(number, { state: 'closed' });
    } else {
      const target = this.cfg.states[to];
      if (!target) throw new Error(`no GitHub label mapped for semantic state "${to}"`);
      const stateLabels = new Set(Object.values(this.cfg.states).filter(Boolean) as string[]);
      const next = [...new Set([...issue.labels.filter((l) => !stateLabels.has(l)), target])];
      await this.patch(number, { state: 'open', labels: next });
    }
    logger.info(`transition ${issue.identifier} → ${to}`);
  }

  private async patch(number: number, body: Record<string, unknown>): Promise<void> {
    await fetchRetry(
      `${this.base()}/issues/${number}`,
      { method: 'PATCH', headers: this.headers, body: JSON.stringify(body) },
      { label: 'github.issue.patch' },
    );
  }

  async createComment(issue: Issue, body: string): Promise<void> {
    await fetchRetry(
      `${this.base()}/issues/${this.numberOf(issue)}/comments`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body }) },
      { label: 'github.issue.comment' },
    );
  }

  async fetchComments(issue: Issue, since?: string): Promise<TrackerComment[]> {
    const params = new URLSearchParams({ per_page: '100' });
    if (since) params.set('since', since);
    const json = await fetchJson<unknown>(
      `${this.base()}/issues/${this.numberOf(issue)}/comments?${params.toString()}`,
      { headers: this.headers },
      { label: 'github.issue.comments' },
    );
    return z
      .array(CommentSchema)
      .parse(json)
      .map((c) => ({ id: String(c.id), author: c.user?.login ?? 'unknown', body: c.body ?? '', createdAt: c.created_at }));
  }

  async getBotIdentity(): Promise<BotIdentity> {
    const json = await fetchJson<{ login: string; id: number }>(
      `${API}/user`,
      { headers: this.headers },
      { label: 'github.user' },
    );
    return { id: String(json.id), name: json.login };
  }

  private toIssue(raw: RawIssue): Issue | null {
    if (raw.pull_request) return null; // the issues endpoint also returns PRs
    const labels = raw.labels.map((l) => (typeof l === 'string' ? l : l.name));
    return {
      identifier: `${this.cfg.identifier_prefix}${raw.number}`,
      internalId: String(raw.number),
      title: raw.title,
      description: raw.body ?? '',
      state: resolveIssueState(raw.state, labels, this.labelToState),
      labels,
      blockedBy: [],
      repoKey: this.cfg.repo_key,
      url: raw.html_url,
      attachments: [],
    };
  }
}

/** Resolve the semantic state: closed → done; open → first label that maps, else planning. */
export function resolveIssueState(
  ghState: string,
  labels: string[],
  labelToState: Map<string, IssueState>,
): IssueState {
  if (ghState === 'closed') return 'done';
  for (const label of labels) {
    const s = labelToState.get(label);
    if (s) return s;
  }
  return 'planning';
}
