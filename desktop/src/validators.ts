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

export function validateAgent(provider: string, key: string): Promise<ValidationResult> {
  if (provider === 'claude') {
    return check('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  }
  // gemini/gpt key checks are provider-specific; skip with a clear note for now.
  return Promise.resolve({ ok: true, detail: `validation not available for ${provider}` });
}
