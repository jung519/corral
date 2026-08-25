/**
 * What survives opening a pipeline in the editor and pressing save.
 *
 * The editor draws a context entry as three boxes and used to rebuild the entry from those
 * three, so a hand-written definition lost everything else the first time anyone saved.
 * Measured against the code as it was:
 *
 *     method POST → GET · headers dropped · credential dropped · auth dropped ·
 *     timeout_ms 30000 → 15000 · an entry written with `values` dropped entirely
 *
 * The credential is what made it a reported bug — an authenticated vocabulary API stops
 * answering and the person is left thinking they never set it (CRL-96). The rest is the
 * same mistake with quieter symptoms.
 *
 * Read from the renderer as a module: it lives in another workspace, outside this
 * project's `rootDir`, so the specifier is computed (a literal one fails `tsc`).
 */
import { beforeAll, describe, expect, it } from 'vitest';

type HttpAuth = {
  service: string;
  account: string;
  value: string;
  saved: boolean;
  header: string;
  prefix: string;
};
type ContextRow = { name: string; url: string; select: string; auth: HttpAuth; original?: Record<string, unknown> };

let readContextRows: (context: unknown, loadAuth: (r: Record<string, unknown>) => HttpAuth) => ContextRow[];
let writeContextRows: (rows: readonly ContextRow[], authFields: (a: HttpAuth) => Record<string, unknown>) => Record<string, unknown>;

const AUTH_HEADER = 'authorization';
const AUTH_PREFIX = 'Bearer ';
const newAuth = (): HttpAuth => ({ service: '', account: 'default', value: '', saved: false, header: AUTH_HEADER, prefix: AUTH_PREFIX });

/** The editor's own reader/writer for the credential leaves, replicated. */
function loadAuth(request: Record<string, unknown>): HttpAuth {
  const a = newAuth();
  const cred = (request.credential ?? {}) as Record<string, unknown>;
  if (cred.service) {
    a.service = String(cred.service);
    a.account = String(cred.account ?? 'default');
  }
  const auth = (request.auth ?? {}) as Record<string, unknown>;
  if (auth.header !== undefined) a.header = String(auth.header);
  if (auth.prefix !== undefined) a.prefix = String(auth.prefix);
  return a;
}
function authFields(a: HttpAuth): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!a.service.trim()) return out;
  out.credential = { service: a.service.trim(), account: a.account.trim() || 'default' };
  if (a.header.trim().toLowerCase() !== AUTH_HEADER || a.prefix !== AUTH_PREFIX) {
    out.auth = { header: a.header.trim() || AUTH_HEADER, prefix: a.prefix };
  }
  return out;
}

beforeAll(async () => {
  const href = new URL('../../renderer/src/lib/context-rows.ts', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ href)) as {
    readContextRows: typeof readContextRows;
    writeContextRows: typeof writeContextRows;
  };
  readContextRows = mod.readContextRows;
  writeContextRows = mod.writeContextRows;
});

/** A definition someone wrote by hand, using the parts the schema has always supported. */
const HAND_WRITTEN = {
  vocabulary: {
    source: {
      method: 'POST',
      url: 'https://api.example.com/vocab',
      headers: { 'X-Tenant': 'acme' },
      credential: { service: 'vocab-api', account: 'default' },
      auth: { header: 'x-api-key', prefix: '' },
      timeout_ms: 30_000,
    },
    select: 'data.terms',
  },
  labels: { values: ['정치', '경제', '사회'] },
};

const roundTrip = (context: unknown) => writeContextRows(readContextRows(context, loadAuth), authFields);

describe('opening and saving without changing anything', () => {
  it('keeps the credential — the reported bug', () => {
    const out = roundTrip(HAND_WRITTEN) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source.credential).toEqual({ service: 'vocab-api', account: 'default' });
  });

  it('keeps how the credential is placed on the wire', () => {
    // An internal API behind a VPC wanting `X-API-Key` is as ordinary as Bearer, and the
    // schema says so; losing it breaks the request just as thoroughly as losing the secret.
    const out = roundTrip(HAND_WRITTEN) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source.auth).toEqual({ header: 'x-api-key', prefix: '' });
  });

  it.each([
    ['method', 'POST'],
    ['timeout_ms', 30_000],
  ])('keeps %s', (key, value) => {
    const out = roundTrip(HAND_WRITTEN) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source[key]).toEqual(value);
  });

  it('keeps headers', () => {
    const out = roundTrip(HAND_WRITTEN) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source.headers).toEqual({ 'X-Tenant': 'acme' });
  });

  /**
   * `values` is a legal way to write a context entry and has no URL to draw. Dropping it
   * because a text box is empty is deleting what the editor merely cannot render.
   */
  it('keeps an entry written with `values` instead of a source', () => {
    const out = roundTrip(HAND_WRITTEN);
    expect(out.labels).toEqual({ values: ['정치', '경제', '사회'] });
  });

  it('keeps the path', () => {
    const out = roundTrip(HAND_WRITTEN) as Record<string, { select?: string }>;
    expect(out.vocabulary!.select).toBe('data.terms');
  });
});

describe('editing', () => {
  it('applies the edited URL over what was there', () => {
    const rows = readContextRows(HAND_WRITTEN, loadAuth);
    rows[0]!.url = 'https://api.example.com/v2/vocab';
    const out = writeContextRows(rows, authFields) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source.url).toBe('https://api.example.com/v2/vocab');
    expect(out.vocabulary!.source.credential).toBeDefined(); // and keeps the rest
  });

  it('lets a credential be cleared', () => {
    // A box that shows a credential but cannot remove one would be a display, not a field.
    const rows = readContextRows(HAND_WRITTEN, loadAuth);
    rows[0]!.auth = newAuth();
    const out = writeContextRows(rows, authFields) as Record<string, { source: Record<string, unknown> }>;
    expect(out.vocabulary!.source.credential).toBeUndefined();
    expect(out.vocabulary!.source.auth).toBeUndefined();
  });

  it('adds a credential to an entry that had none', () => {
    const rows = readContextRows({ plain: { source: { url: 'https://x/y' } } }, loadAuth);
    rows[0]!.auth = { ...newAuth(), service: 'vocab-api' };
    const out = writeContextRows(rows, authFields) as Record<string, { source: Record<string, unknown> }>;
    expect(out.plain!.source.credential).toEqual({ service: 'vocab-api', account: 'default' });
    // Default placement is not written — the same rule the input block follows.
    expect(out.plain!.source.auth).toBeUndefined();
  });

  it('clears the path when the box is emptied', () => {
    const rows = readContextRows(HAND_WRITTEN, loadAuth);
    rows[0]!.select = '';
    const out = writeContextRows(rows, authFields) as Record<string, Record<string, unknown>>;
    expect(out.vocabulary!.select).toBeUndefined();
  });

  it('writes nothing for a row that was added and left blank', () => {
    const out = writeContextRows([{ name: '', url: '', select: '', auth: newAuth() }], authFields);
    expect(out).toEqual({});
  });

  it('writes a newly added row', () => {
    const out = writeContextRows(
      [{ name: 'terms', url: 'https://x/y', select: 'items', auth: newAuth() }],
      authFields,
    ) as Record<string, unknown>;
    expect(out.terms).toEqual({ source: { url: 'https://x/y' }, select: 'items' });
  });

  it('drops a named row whose URL was emptied and had nothing to preserve', () => {
    // Not the `values` case: this row never carried anything else.
    const out = writeContextRows([{ name: 'terms', url: '', select: '', auth: newAuth() }], authFields);
    expect(out).toEqual({});
  });
});

describe('the secret itself', () => {
  it('never reaches the definition', () => {
    // It goes to the credential store; the definition only ever names it.
    const rows = readContextRows({ plain: { source: { url: 'https://x/y' } } }, loadAuth);
    rows[0]!.auth = { ...newAuth(), service: 'vocab-api', value: 'sk-secret-value' };
    expect(JSON.stringify(writeContextRows(rows, authFields))).not.toContain('sk-secret-value');
  });
});
