/**
 * The `agent.context` block, between the definition and the editor.
 *
 * The editor draws a context entry as three boxes — name, URL, path — and used to rebuild
 * the whole entry from those three when saving. Everything else a hand-written definition
 * had was gone the first time someone opened the editor and pressed save:
 *
 *     method       POST                                     → default GET
 *     headers      {"X-Tenant":"acme"}                      → {}
 *     credential   {"service":"vocab-api",…}                → gone
 *     auth         {"header":"x-api-key","prefix":""}       → default Bearer
 *     timeout_ms   30000                                    → default 15000
 *     an entry written with `values` instead of `source`    → dropped entirely
 *
 * The credential is what makes it a reported bug (CRL-96): an authenticated vocabulary API
 * stops working and the person is left thinking they never set it. The rest is the same
 * mistake with quieter symptoms.
 *
 * So the entry is *edited*, not rebuilt: whatever came in is kept and the three edited
 * fields are laid over it. Not drawing something is different from deleting it — the same
 * rule the config merge follows for the blocks the wizard does not model (CRL-77).
 */
/**
 * Credential + auth placement for one HTTP block, as the editor holds it while open.
 *
 * `value` is what was typed and never reaches a definition — it goes to the credential
 * store; the definition only ever names the secret.
 */
export interface HttpAuth {
  service: string;
  account: string;
  value: string;
  saved: boolean;
  header: string;
  prefix: string;
}

export interface ContextRow {
  name: string;
  url: string;
  select: string;
  /** Credential + auth placement, in the same shape the input and output blocks use. */
  auth: HttpAuth;
  /**
   * The entry as it was read, so saving can put back what the editor does not draw.
   *
   * Absent on a row the person just added, which has nothing to preserve.
   */
  original?: Record<string, unknown>;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Definition → rows.
 *
 * `loadAuth` is the editor's own reader for the credential leaves; it is passed in rather
 * than imported so this module stays free of component state.
 */
export function readContextRows(
  context: unknown,
  loadAuth: (request: Record<string, unknown>) => HttpAuth,
): ContextRow[] {
  return Object.entries(obj(context)).map(([name, entry]) => {
    const source = obj(obj(entry).source);
    return {
      name,
      url: String(source.url ?? ''),
      select: String(obj(entry).select ?? ''),
      auth: loadAuth(source),
      original: obj(entry),
    };
  });
}

/**
 * Rows → definition.
 *
 * An entry with no URL is not dropped when it arrived that way: `values` entries are legal
 * and have no URL to draw, and deleting one because a text box is empty is the loss this
 * function exists to stop. A row the person added and left blank has no `original`, so it
 * is simply not written.
 */
export function writeContextRows(
  rows: readonly ContextRow[],
  authFields: (a: HttpAuth) => Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const url = row.url.trim();
    if (!url) {
      // Nothing to draw and nothing typed — keep whatever it was (a `values` list).
      if (row.original && Object.keys(row.original).length > 0) out[name] = row.original;
      continue;
    }
    const before = obj(row.original);
    const source = { ...obj(before.source), url, ...authFields(row.auth) };
    // A credential cleared in the editor has to actually clear, or the box would be a
    // display that cannot be undone.
    if (!authFields(row.auth).credential) {
      delete (source as Record<string, unknown>).credential;
      delete (source as Record<string, unknown>).auth;
    }
    const select = row.select.trim();
    out[name] = { ...before, source, ...(select ? { select } : {}) };
    if (!select) delete (out[name] as Record<string, unknown>).select;
  }
  return out;
}
