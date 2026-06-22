/**
 * Connection validators — run in the Electron main process (node fetch, no CORS)
 * so the setup wizard can verify tokens BEFORE writing config, instead of failing
 * at first dispatch. Best-effort: a network error is reported, not thrown.
 */
export interface ValidationResult {
  ok: boolean;
  detail?: string;
}

async function check(url: string, headers: Record<string, string>): Promise<ValidationResult> {
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function validateNotion(token: string): Promise<ValidationResult> {
  return check('https://api.notion.com/v1/users/me', {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
  });
}

export function validateGithub(token: string): Promise<ValidationResult> {
  return check('https://api.github.com/user', {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'corral',
  });
}

export interface NotionPropInfo {
  name: string;
  /** Notion property type (status, select, unique_id, checkbox, multi_select, …). */
  type: string;
  /** Choice names for status/select/multi_select; empty otherwise. */
  options: string[];
}

export interface NotionSchemaResult {
  ok: boolean;
  properties?: NotionPropInfo[];
  detail?: string;
}

/** Read a Notion database's property schema so the wizard can offer property names
 * and their option values as dropdowns (no manual typing → no name mismatches). */
export async function fetchNotionSchema(token: string, databaseId: string): Promise<NotionSchemaResult> {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const json = (await res.json()) as { properties?: Record<string, unknown> };
    const properties: NotionPropInfo[] = [];
    for (const [name, raw] of Object.entries(json.properties ?? {})) {
      const p = raw as { type?: string; [k: string]: unknown };
      const type = String(p.type ?? '');
      const holder = p[type] as { options?: Array<{ name?: string }> } | undefined;
      const options =
        (type === 'status' || type === 'select' || type === 'multi_select') && holder?.options
          ? holder.options.map((o) => String(o.name ?? ''))
          : [];
      properties.push({ name, type, options });
    }
    return { ok: true, properties };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function pickStr(j: unknown, key: string): string | undefined {
  if (j && typeof j === 'object' && key in j) {
    const v = (j as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function notionDbTitle(j: unknown): string | undefined {
  const title = (j as { title?: Array<{ plain_text?: string }> })?.title;
  if (!Array.isArray(title)) return undefined;
  return title.map((x) => x.plain_text ?? '').join('').trim() || undefined;
}

/** GET that confirms a resource is reachable; on success returns a friendly name. */
async function reach(
  url: string,
  headers: Record<string, string>,
  pick?: (j: unknown) => string | undefined,
): Promise<ValidationResult> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { message?: string };
        if (j?.message) detail += `: ${String(j.message).slice(0, 140)}`;
      } catch {
        /* no body */
      }
      return { ok: false, detail };
    }
    let detail: string | undefined;
    if (pick) {
      try {
        detail = pick(await res.json());
      } catch {
        /* ignore */
      }
    }
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface RepoTestInput {
  kind: 'github' | 'gitlab' | 'bitbucket';
  repo: string;
  token: string;
  host?: string;
  username?: string;
}

/** Confirm the specific repository (not just the token) is reachable with the token. */
export async function testRepoConnection(input: RepoTestInput): Promise<ValidationResult> {
  const { kind, repo, token } = input;
  if (!repo.trim() || !token.trim()) return { ok: false, detail: 'repo and token are required' };
  if (kind === 'github') {
    return reach(
      `https://api.github.com/repos/${repo}`,
      { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'corral' },
      (j) => pickStr(j, 'full_name'),
    );
  }
  if (kind === 'gitlab') {
    const host = (input.host || 'https://gitlab.com').replace(/\/+$/, '');
    return reach(`${host}/api/v4/projects/${encodeURIComponent(repo)}`, { 'PRIVATE-TOKEN': token }, (j) =>
      pickStr(j, 'path_with_namespace'),
    );
  }
  const basic = Buffer.from(`${input.username ?? ''}:${token}`).toString('base64');
  return reach(`https://api.bitbucket.org/2.0/repositories/${repo}`, { Authorization: `Basic ${basic}` }, (j) =>
    pickStr(j, 'full_name'),
  );
}

export interface TrackerTestInput {
  kind: 'notion' | 'github_issues' | 'jira';
  token: string;
  databaseId?: string;
  repo?: string;
  host?: string;
  email?: string;
  project?: string;
}

/** Confirm the tracker source (DB / issues repo / Jira project) is reachable. */
export async function testTrackerConnection(input: TrackerTestInput): Promise<ValidationResult> {
  if (input.kind === 'notion') {
    if (!input.databaseId?.trim() || !input.token.trim()) return { ok: false, detail: 'database id and token are required' };
    return reach(
      `https://api.notion.com/v1/databases/${encodeURIComponent(input.databaseId)}`,
      { Authorization: `Bearer ${input.token}`, 'Notion-Version': '2022-06-28' },
      (j) => notionDbTitle(j),
    );
  }
  if (input.kind === 'github_issues') {
    if (!input.repo?.trim() || !input.token.trim()) return { ok: false, detail: 'issues repo and a GitHub token are required' };
    return reach(
      `https://api.github.com/repos/${input.repo}`,
      { Authorization: `Bearer ${input.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'corral' },
      (j) => pickStr(j, 'full_name'),
    );
  }
  const host = (input.host ?? '').replace(/\/+$/, '');
  if (!host || !input.email?.trim() || !input.token.trim() || !input.project?.trim()) {
    return { ok: false, detail: 'host, email, token and project are required' };
  }
  const basic = Buffer.from(`${input.email}:${input.token}`).toString('base64');
  return reach(
    `${host}/rest/api/3/project/${encodeURIComponent(input.project)}`,
    { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    (j) => pickStr(j, 'name'),
  );
}

/** Confirm the skills/reference repo is reachable. Auto-test supports a GitHub
 * "owner/name" or a github.com URL (token optional for public repos). */
export async function testReferenceConnection(repo: string, token: string): Promise<ValidationResult> {
  const r = repo.trim();
  if (!r) return { ok: false, detail: 'reference repo is required' };
  const m = r.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  const ownerName = m?.[1] ?? (/^[^/\s]+\/[^/\s]+$/.test(r) ? r : null);
  if (!ownerName) return { ok: false, detail: 'auto-test supports a GitHub owner/name or github.com URL' };
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'corral' };
  if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return reach(`https://api.github.com/repos/${ownerName}`, headers, (j) => pickStr(j, 'full_name'));
}

export function validateAgent(provider: string, key: string): Promise<ValidationResult> {
  if (provider === 'claude') {
    return check('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  }
  if (provider === 'gemini') {
    // Gemini API keys go in the query string, not a header.
    return check(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {});
  }
  // gpt key check is provider-specific; skip with a clear note until codex lands.
  return Promise.resolve({ ok: true, detail: `validation not available for ${provider}` });
}
