/**
 * Notion tracker — implements TrackerAdapter over the Notion REST API.
 *
 * Mapping of Corral semantics onto a Notion database:
 *   kanban column   ← a `status`- OR `select`-type property (config properties.status;
 *                      the type is auto-detected from the DB schema)
 *   identifier       ← a `unique_id`-type property      (config properties.identifier → "ISS-131")
 *   repo routing     ← a `select`-type property         (config properties.repo → repository.key)
 *   description      ← the page's child blocks, flattened to text
 *
 * Lifted from upstream. Adaptation: the API token comes from the resolved
 * CredentialStore (ctx.token), not an inline config field.
 */
import { z } from 'zod';
import type { TrackerConfig } from '../config/schema.js';
import { fetchJson, fetchRetry } from '../core/fetch-retry.js';
import { logger } from '../core/logger.js';
import type {
  Attachment,
  AttachmentKind,
  BotIdentity,
  CandidatePage,
  Issue,
  IssueState,
  TrackerAdapter,
  TrackerComment,
} from '../core/types.js';

export interface TrackerCtx {
  /** Resolved API token (from the CredentialStore). */
  token: string;
}

type NotionConfig = Extract<TrackerConfig, { kind: 'notion' }>;

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

// ───────────────────────────────────────────────────── boundary zod schemas
// Kept permissive (.passthrough) — we only validate the fields we read.

const RichTextItem = z.object({ plain_text: z.string() }).passthrough();

const PageProperty = z
  .object({
    type: z.string(),
    status: z.object({ name: z.string() }).nullable().optional(),
    select: z.object({ name: z.string() }).nullable().optional(),
    multi_select: z.array(z.object({ name: z.string() })).optional(),
    unique_id: z.object({ prefix: z.string().nullable(), number: z.number().nullable() }).optional(),
    title: z.array(RichTextItem).optional(),
    relation: z.array(z.object({ id: z.string() })).optional(),
  })
  .passthrough();

const Page = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    properties: z.record(PageProperty),
  })
  .passthrough();

const QueryResponse = z.object({
  results: z.array(Page),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const BlockChildren = z.object({
  results: z.array(z.record(z.unknown())),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const CommentsResponse = z.object({
  results: z.array(
    z
      .object({
        id: z.string(),
        created_time: z.string(),
        created_by: z.object({ id: z.string() }).passthrough(),
        rich_text: z.array(RichTextItem),
      })
      .passthrough(),
  ),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const MeResponse = z.object({ id: z.string(), name: z.string().nullable().optional() });

/** Minimal DB schema read — just the property types, to detect status vs select. */
const DatabaseSchema = z
  .object({ properties: z.record(z.object({ type: z.string() }).passthrough()) })
  .passthrough();

type NotionPage = z.infer<typeof Page>;

// ───────────────────────────────────────────────────────────── the adapter

export class NotionTracker implements TrackerAdapter {
  readonly kind = 'notion';
  private readonly headers: Record<string, string>;
  /** reverse map: tracker status name → semantic state */
  private readonly nameToState = new Map<string, IssueState>();
  /** semantic state → tracker status name */
  private readonly stateToName = new Map<IssueState, string>();
  /** Kanban property type — Notion 'status' and 'select' need different filter/read/
   * write syntax. Detected once from the DB schema (cached). */
  private statusKind: 'status' | 'select' | null = null;

  constructor(
    private readonly cfg: NotionConfig,
    ctx: TrackerCtx,
  ) {
    this.headers = {
      Authorization: `Bearer ${ctx.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
    // states are iterated planning → plan_review → … so when a coarse board maps
    // several semantics onto one column, the reverse map keeps the FIRST (entry)
    // semantic — e.g. a shared "Backlog" resolves to `planning`, not `plan_review`.
    for (const [semantic, name] of Object.entries(cfg.states)) {
      if (!name) continue;
      if (!this.nameToState.has(name)) this.nameToState.set(name, semantic as IssueState);
      this.stateToName.set(semantic as IssueState, name);
    }
  }

  /**
   * Distinct tracker status names the orchestrator acts on (not terminal).
   * Deduped because a coarse board may map several semantic states onto one column.
   */
  private activeStateNames(): string[] {
    const active: IssueState[] = ['planning', 'plan_review', 'in_progress', 'in_review'];
    const names = active.map((s) => this.stateToName.get(s)).filter((n): n is string => Boolean(n));
    return [...new Set(names)];
  }

  /** Detect whether the kanban property is a Notion `status` or `select` type
   * (their filter/read/write syntax differ). Read once from the DB schema, cached. */
  private async resolveStatusKind(): Promise<'status' | 'select'> {
    if (this.statusKind) return this.statusKind;
    const json = await fetchJson<unknown>(
      `${API}/databases/${this.cfg.database_id}`,
      { headers: this.headers },
      { label: 'notion.database' },
    );
    const prop = DatabaseSchema.parse(json).properties[this.cfg.properties.status];
    if (!prop) throw new Error(`Notion property "${this.cfg.properties.status}" not found in the database`);
    if (prop.type !== 'status' && prop.type !== 'select') {
      throw new Error(`Notion property "${this.cfg.properties.status}" is type "${prop.type}" — expected status or select`);
    }
    this.statusKind = prop.type;
    logger.info(`notion status property "${this.cfg.properties.status}" detected as ${prop.type}`);
    return prop.type;
  }

  /** Notion query filter restricting candidates to the configured scope. */
  private scopeFilter(): Record<string, unknown> | null {
    const scope = this.cfg.scope;
    if (!scope) return null;
    if (scope.type === 'checkbox') {
      return { property: scope.property, checkbox: { equals: scope.checked } };
    }
    if (scope.values.length === 0) return null;
    const key = scope.type; // 'select' | 'multi_select' | 'status'
    const op = scope.type === 'multi_select' ? 'contains' : 'equals';
    return { or: scope.values.map((v) => ({ property: scope.property, [key]: { [op]: v } })) };
  }

  /** Notion query filter for candidate issues (active status + optional scope). */
  private async candidateFilter(): Promise<Record<string, unknown>> {
    const statusProp = this.cfg.properties.status;
    const kind = await this.resolveStatusKind();
    const statusFilter = {
      or: this.activeStateNames().map((name) => ({ property: statusProp, [kind]: { equals: name } })),
    };
    const scope = this.scopeFilter();
    return scope ? { and: [statusFilter, scope] } : statusFilter;
  }

  /** One ID-ascending page for the picker — sorted server-side, body NOT fetched (start
   *  re-fetches it via fetchIssueByIdentifier). This is what makes the picker fast. */
  async fetchCandidatePage(opts: { cursor?: string; limit?: number; search?: string } = {}): Promise<CandidatePage> {
    const { cursor, limit = 10 } = opts;
    const body: Record<string, unknown> = {
      filter: await this.candidateFilter(),
      page_size: limit,
      sorts: [{ property: this.cfg.properties.identifier, direction: 'ascending' }],
    };
    if (cursor) body.start_cursor = cursor;
    const json = await fetchJson<unknown>(
      `${API}/databases/${this.cfg.database_id}/query`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      { label: 'notion.query.page' },
    );
    const parsed = QueryResponse.parse(json);
    const items: Issue[] = [];
    for (const page of parsed.results) {
      const issue = this.toIssue(page);
      if (issue) items.push(issue);
    }
    return { items, nextCursor: parsed.has_more ? (parsed.next_cursor ?? undefined) : undefined };
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const filter = await this.candidateFilter();
    const issues: Issue[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = { filter, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const json = await fetchJson<unknown>(
        `${API}/databases/${this.cfg.database_id}/query`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
        { label: 'notion.query' },
      );
      const parsed = QueryResponse.parse(json);
      for (const page of parsed.results) {
        const issue = this.toIssue(page);
        if (issue) issues.push(issue);
      }
      cursor = parsed.has_more ? parsed.next_cursor : null;
    } while (cursor);

    for (const issue of issues) {
      const body = await this.fetchPageBody(issue.internalId).catch(() => ({ text: '', attachments: [] }));
      issue.description = body.text;
      issue.attachments = body.attachments;
    }
    return issues;
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    // unique_id can't be filtered by composed string; match prefix+number.
    const idProp = this.cfg.properties.identifier;
    const dashIdx = identifier.lastIndexOf('-');
    const number = Number(identifier.slice(dashIdx + 1));
    if (Number.isNaN(number)) return null;

    const json = await fetchJson<unknown>(
      `${API}/databases/${this.cfg.database_id}/query`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ filter: { property: idProp, unique_id: { equals: number } }, page_size: 5 }),
      },
      { label: 'notion.query.byId' },
    );
    const parsed = QueryResponse.parse(json);
    const page = parsed.results.find((p) => this.identifierOf(p) === identifier);
    if (!page) return null;
    const issue = this.toIssue(page);
    if (issue) {
      const body = await this.fetchPageBody(page.id).catch(() => ({ text: '', attachments: [] }));
      issue.description = body.text;
      issue.attachments = body.attachments;
    }
    return issue;
  }

  async transitionIssue(issue: Issue, to: IssueState): Promise<void> {
    const name = this.stateToName.get(to);
    if (!name) throw new Error(`No Notion status name mapped for semantic state "${to}"`);
    const kind = await this.resolveStatusKind();
    await fetchRetry(
      `${API}/pages/${issue.internalId}`,
      {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ properties: { [this.cfg.properties.status]: { [kind]: { name } } } }),
      },
      { label: 'notion.transition' },
    );
    logger.info(`transition ${issue.identifier} → ${to} (${name})`);
  }

  async createComment(issue: Issue, body: string): Promise<void> {
    await fetchRetry(
      `${API}/comments`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ parent: { page_id: issue.internalId }, rich_text: chunkRichText(body) }),
      },
      { label: 'notion.comment' },
    );
  }

  async fetchComments(issue: Issue, since?: string): Promise<TrackerComment[]> {
    const out: TrackerComment[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ block_id: issue.internalId, page_size: '100' });
      if (cursor) params.set('start_cursor', cursor);
      const json = await fetchJson<unknown>(
        `${API}/comments?${params.toString()}`,
        { headers: this.headers },
        { label: 'notion.comments' },
      );
      const parsed = CommentsResponse.parse(json);
      for (const c of parsed.results) {
        if (since && c.created_time <= since) continue;
        out.push({
          id: c.id,
          author: c.created_by.id,
          body: c.rich_text.map((r) => r.plain_text).join(''),
          createdAt: c.created_time,
        });
      }
      cursor = parsed.has_more ? parsed.next_cursor : null;
    } while (cursor);
    return out;
  }

  async getBotIdentity(): Promise<BotIdentity> {
    const json = await fetchJson<unknown>(`${API}/users/me`, { headers: this.headers }, { label: 'notion.me' });
    const me = MeResponse.parse(json);
    return { id: me.id, name: me.name ?? 'notion-bot' };
  }

  // ─────────────────────────────────────────────────────────── helpers

  private toIssue(page: NotionPage): Issue | null {
    const identifier = this.identifierOf(page);
    if (!identifier) {
      logger.warn(`Notion page ${page.id} has no "${this.cfg.properties.identifier}" unique_id; skipped`);
      return null;
    }
    // Read works for both kinds — only one of status/select is present on the page.
    const sp = page.properties[this.cfg.properties.status];
    const statusName = sp?.status?.name ?? sp?.select?.name;
    const state = statusName ? this.nameToState.get(statusName) : undefined;
    if (!state) return null; // not in an active mapped state

    return {
      identifier,
      internalId: page.id,
      title: this.titleOf(page),
      description: '', // hydrated separately
      state,
      labels: this.labelsOf(page),
      blockedBy: [],
      repoKey: this.repoKeyOf(page),
      url: page.url,
      attachments: [], // hydrated separately via fetchPageBody
    };
  }

  private identifierOf(page: NotionPage): string | null {
    const prop = page.properties[this.cfg.properties.identifier];
    const uid = prop?.unique_id;
    if (!uid || uid.number === null) return null;
    return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
  }

  private titleOf(page: NotionPage): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === 'title' && prop.title) {
        return prop.title
          .map((t) => t.plain_text)
          .join('')
          .trim();
      }
    }
    return '(untitled)';
  }

  private repoKeyOf(page: NotionPage): string | undefined {
    const repoProp = this.cfg.properties.repo;
    if (!repoProp) return undefined;
    const prop = page.properties[repoProp];
    if (!prop) return undefined;
    if (prop.select) return prop.select.name;
    if (prop.multi_select && prop.multi_select.length > 0) return prop.multi_select[0]?.name;
    return undefined;
  }

  private labelsOf(page: NotionPage): string[] {
    const repoProp = this.cfg.properties.repo;
    if (!repoProp) return [];
    const prop = page.properties[repoProp];
    const labels: string[] = [];
    if (prop?.multi_select) labels.push(...prop.multi_select.map((m) => m.name));
    if (prop?.select) labels.push(prop.select.name);
    return labels;
  }

  /** Flatten a page's child blocks into text + collect file/image/pdf attachments. */
  private async fetchPageBody(pageId: string): Promise<{ text: string; attachments: Attachment[] }> {
    const lines: string[] = [];
    const attachments: Attachment[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ page_size: '100' });
      if (cursor) params.set('start_cursor', cursor);
      const json = await fetchJson<unknown>(
        `${API}/blocks/${pageId}/children?${params.toString()}`,
        { headers: this.headers },
        { label: 'notion.blocks' },
      );
      const parsed = BlockChildren.parse(json);
      for (const block of parsed.results) {
        lines.push(blockToText(block));
        const att = blockToAttachment(block);
        if (att) attachments.push(att);
      }
      cursor = parsed.has_more ? parsed.next_cursor : null;
    } while (cursor);
    return { text: lines.filter(Boolean).join('\n'), attachments };
  }
}

// ───────────────────────────────────────────────────────── pure helpers

/** Extract plain_text from any rich_text array nested inside a block's type object. */
export function blockToText(block: Record<string, unknown>): string {
  const type = block.type as string | undefined;
  if (!type) return '';
  const payload = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!payload?.rich_text) return '';
  return payload.rich_text.map((r) => r.plain_text ?? '').join('');
}

/** Extract a downloadable attachment from a file/image/pdf block. */
export function blockToAttachment(block: Record<string, unknown>): Attachment | null {
  const type = block.type as string | undefined;
  if (type !== 'file' && type !== 'image' && type !== 'pdf') return null;
  const payload = block[type] as
    | { type?: string; name?: string; file?: { url?: string }; external?: { url?: string } }
    | undefined;
  const url = payload?.file?.url ?? payload?.external?.url;
  if (!url) return null;
  const name = payload?.name?.trim() || fileNameFromUrl(url) || `${type}-attachment`;
  return { kind: classifyAttachment(name, type), name, url };
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

export function classifyAttachment(name: string, blockType: string): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'md';
  if (ext === 'pdf' || blockType === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) || blockType === 'image') return 'image';
  return 'other';
}

/** Notion rich_text content is capped at 2000 chars per item — split long bodies. */
function chunkRichText(body: string): Array<{ text: { content: string } }> {
  const MAX = 1900;
  const chunks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < body.length; i += MAX) {
    chunks.push({ text: { content: body.slice(i, i + MAX) } });
  }
  return chunks.length ? chunks : [{ text: { content: '' } }];
}
