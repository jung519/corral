/**
 * Jira Cloud tracker — REST v3. Auth: email + API token (Basic). Semantic states
 * map to Jira workflow status names; transitions are resolved to a transition id.
 * Issue/comment bodies are Atlassian Document Format (ADF) — flattened to text in,
 * wrapped to ADF out.
 */
import { z } from 'zod';
import type { TrackerConfig } from '../config/schema.js';
import { fetchJson, fetchRetry } from '../core/fetch-retry.js';
import { logger } from '../core/logger.js';
import type { BotIdentity, Issue, IssueState, TrackerAdapter, TrackerComment } from '../core/types.js';

export interface TrackerCtx {
  token: string;
}

type JiraConfig = Extract<TrackerConfig, { kind: 'jira' }>;

const IssueSchema = z
  .object({
    key: z.string(),
    fields: z
      .object({
        summary: z.string().default(''),
        labels: z.array(z.string()).default([]),
        description: z.unknown().optional(),
        status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }).optional() }).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const ACTIVE: IssueState[] = ['planning', 'plan_review', 'in_progress', 'in_review'];

export class JiraTracker implements TrackerAdapter {
  readonly kind = 'jira';
  private readonly api: string;
  private readonly headers: Record<string, string>;
  private readonly nameToState = new Map<string, IssueState>();

  constructor(
    private readonly cfg: JiraConfig,
    ctx: TrackerCtx,
  ) {
    this.api = `${cfg.host.replace(/\/$/, '')}/rest/api/3`;
    const basic = Buffer.from(`${cfg.email}:${ctx.token}`).toString('base64');
    this.headers = { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    for (const [semantic, name] of Object.entries(cfg.states)) {
      if (name && !this.nameToState.has(name)) this.nameToState.set(name, semantic as IssueState);
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const jql = `project = "${this.cfg.project}" AND statusCategory != Done ORDER BY created DESC`;
    const json = await fetchJson<unknown>(
      `${this.api}/search/jql`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jql, maxResults: 100, fields: ['summary', 'status', 'labels', 'description'] }),
      },
      { label: 'jira.search' },
    );
    const parsed = z.object({ issues: z.array(IssueSchema).default([]) }).parse(json);
    return parsed.issues.map((raw) => this.toIssue(raw)).filter((i) => ACTIVE.includes(i.state));
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    try {
      const json = await fetchJson<unknown>(
        `${this.api}/issue/${identifier}?fields=summary,status,labels,description`,
        { headers: this.headers },
        { label: 'jira.issue' },
      );
      return this.toIssue(IssueSchema.parse(json));
    } catch {
      return null;
    }
  }

  async transitionIssue(issue: Issue, to: IssueState): Promise<void> {
    const target = this.cfg.states[to];
    if (!target) throw new Error(`no Jira status mapped for semantic state "${to}"`);
    const list = await fetchJson<unknown>(
      `${this.api}/issue/${issue.identifier}/transitions`,
      { headers: this.headers },
      { label: 'jira.transitions' },
    );
    const transitions = z
      .object({ transitions: z.array(z.object({ id: z.string(), to: z.object({ name: z.string() }) })).default([]) })
      .parse(list).transitions;
    const match = transitions.find((tr) => tr.to.name === target);
    if (!match) {
      logger.child(issue.identifier).warn(`no Jira transition to "${target}" (available: ${transitions.map((t) => t.to.name).join(', ')})`);
      return;
    }
    await fetchRetry(
      `${this.api}/issue/${issue.identifier}/transitions`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ transition: { id: match.id } }) },
      { label: 'jira.transition' },
    );
  }

  async createComment(issue: Issue, body: string): Promise<void> {
    await fetchRetry(
      `${this.api}/issue/${issue.identifier}/comment`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body: toAdf(body) }) },
      { label: 'jira.comment' },
    );
  }

  async fetchComments(issue: Issue, since?: string): Promise<TrackerComment[]> {
    const json = await fetchJson<unknown>(
      `${this.api}/issue/${issue.identifier}/comment`,
      { headers: this.headers },
      { label: 'jira.comments' },
    );
    const parsed = z
      .object({
        comments: z
          .array(
            z.object({
              id: z.string(),
              author: z.object({ displayName: z.string().optional(), accountId: z.string().optional() }).optional(),
              body: z.unknown().optional(),
              created: z.string(),
            }),
          )
          .default([]),
      })
      .parse(json);
    return parsed.comments
      .filter((c) => !since || c.created > since)
      .map((c) => ({
        id: c.id,
        author: c.author?.accountId ?? c.author?.displayName ?? 'unknown',
        body: flattenAdf(c.body),
        createdAt: c.created,
      }));
  }

  async getBotIdentity(): Promise<BotIdentity> {
    const json = await fetchJson<{ accountId: string; displayName?: string }>(
      `${this.api}/myself`,
      { headers: this.headers },
      { label: 'jira.myself' },
    );
    return { id: json.accountId, name: json.displayName ?? 'jira-bot' };
  }

  private toIssue(raw: z.infer<typeof IssueSchema>): Issue {
    return {
      identifier: raw.key,
      internalId: raw.key,
      title: raw.fields.summary,
      description: flattenAdf(raw.fields.description),
      state: resolveJiraState(raw.fields.status?.statusCategory?.key, raw.fields.status?.name, this.nameToState),
      labels: raw.fields.labels,
      blockedBy: [],
      repoKey: this.cfg.repo_key,
      url: `${this.cfg.host.replace(/\/$/, '')}/browse/${raw.key}`,
      attachments: [],
    };
  }
}

/** statusCategory "done" → done; else map by status name; else planning. */
export function resolveJiraState(
  categoryKey: string | undefined,
  statusName: string | undefined,
  nameToState: Map<string, IssueState>,
): IssueState {
  if (categoryKey === 'done') return 'done';
  if (statusName) {
    const s = nameToState.get(statusName);
    if (s) return s;
  }
  return 'planning';
}

/** Flatten an Atlassian Document Format node tree to plain text (best effort). */
export function flattenAdf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  const inner = Array.isArray(n.content) ? n.content.map(flattenAdf).join('') : '';
  return n.type === 'paragraph' ? inner + '\n' : inner;
}

/** Wrap plain text as a minimal ADF document for posting. */
function toAdf(text: string): unknown {
  return { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
