/**
 * Making the HTTP call a pipeline definition describes.
 *
 * Shared by anything in a pipeline that reaches out — fetching an input, fetching a
 * vocabulary, delivering a result. All of them take the same `request` block, so they
 * take the same code: one place that knows how a credential becomes a header and how
 * `{{field}}` becomes a value.
 *
 * Secrets never appear in a definition. The request names a credential, the store
 * resolves it, and it goes out as a bearer token.
 */
import { fetchJson } from '../core/fetch-retry.js';
import type { CredentialRef, CredentialStore } from '../credentials/types.js';
import type { Fields } from './pipeline/ports.js';
import { fillTemplate, fillValue, placeholderNames } from './pipeline/run.js';
import type { HttpRequestDef } from './pipeline/schema.js';

/**
 * Retries for one pipeline request.
 *
 * The shared default is five, which suits a long-running issue that would rather wait
 * than fail. A pipeline run is seconds long and there are thousands of them; holding one
 * open for half a minute of backoff blocks a concurrency slot and delays every event
 * behind it. The queue redelivers, so failing quickly loses nothing.
 */
const MAX_RETRIES = 1;

/**
 * Fill `{{field}}` placeholders throughout a value, however deeply nested.
 *
 * Types survive: `{ labels: "{{items}}" }` puts the list itself in the body, not a
 * comma-joined rendering of it. For a JSON body that is the whole point — the receiver
 * declared `labels` an array, and text is not one.
 */
export function fillDeep(value: unknown, fields: Fields): unknown {
  if (typeof value === 'string') return fillValue(value, fields);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, fields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, fields)]));
  }
  return value;
}

/**
 * The same, for somewhere only text belongs — headers.
 *
 * Names are lower-cased. HTTP treats them case-insensitively but a plain object does not,
 * so `Authorization` from the definition and `authorization` from the credential would
 * both survive into the request and go out comma-joined — an auth header holding two
 * values, which no server reads as either of them.
 */
function fillStrings(map: Record<string, string>, fields: Fields): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), fillTemplate(v, fields)]));
}

/**
 * A request that named a field the run does not have.
 *
 * Named so the lifecycle can tell it from a transport failure: the two want opposite
 * things from a queue. A wrong address is the same wrong address on redelivery, so the
 * input stage reads this as a conclusion rather than something to retry.
 */
export class TemplateUnresolvedError extends Error {
  constructor(where: string, names: string[]) {
    super(`${where} needs ${names.map((n) => `"${n}"`).join(', ')}, and this run has no such field`);
    this.name = 'TemplateUnresolvedError';
  }
}

/**
 * Refuse a request whose address still has a hole in it.
 *
 * `fillTemplate` renders an unknown name as nothing, which is right for a prompt — a
 * sentence with a gap is still a sentence. An address is not: `/records/{{id}}` with no
 * `id` becomes `/records/`, which is a *different address*, and sending there is not what
 * the definition said to do. On the output side the receiver often answers 200 to it, so
 * the run was recorded `completed` while the answer went nowhere anyone wanted (CRL-74) —
 * the same silently-successful failure CRL-63 was about, at the other end of the run.
 *
 * **Only `undefined` and `null` count as missing.** An empty string is a value somebody
 * chose, and `fillValue` already draws that line for bodies for the same reason: refusing
 * it would be us second-guessing data rather than catching an absent field.
 *
 * Headers are checked with the URL because they are filled the same way — text, with a
 * missing name silently becoming ''. The body is not: `fillValue` sends `null` there, which
 * is a value the receiver can see and act on, and is a decided behaviour rather than a gap.
 */
function refuseHoles(request: HttpRequestDef, fields: Fields): void {
  const holes = (text: string): string[] =>
    placeholderNames(text).filter((name) => fields[name] === undefined || fields[name] === null);

  const inUrl = holes(request.url);
  if (inUrl.length) throw new TemplateUnresolvedError('the url', inUrl);

  for (const [header, value] of Object.entries(request.headers)) {
    const inHeader = holes(value);
    if (inHeader.length) throw new TemplateUnresolvedError(`header "${header}"`, inHeader);
  }
}

/** Perform the request a definition describes, with `fields` filled in. */
export async function runHttpRequest<T = unknown>(
  request: HttpRequestDef,
  fields: Fields,
  credentials?: CredentialStore,
): Promise<T> {
  // Before anything is built, let alone sent: a request with a hole in its address is not
  // the request the definition described.
  refuseHoles(request, fields);

  // Not `fillDeep`: a header is text by definition, and a list rendered into one would be
  // sent as `[object Object]` by the fetch layer rather than refused here.
  const headers: Record<string, string> = fillStrings(request.headers, fields);

  if (request.credential && credentials) {
    const secret = await credentials.get(request.credential as CredentialRef);
    // `??=`, so a header written into the definition wins over the credential — both are
    // lower-cased above, which is what makes that comparison mean anything.
    if (secret) headers[request.auth.header.toLowerCase()] ??= `${request.auth.prefix}${secret}`;
  }

  const body = request.body ? (fillDeep(request.body, fields) as Record<string, unknown>) : undefined;
  if (body) headers['content-type'] ??= 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout_ms);
  try {
    return await fetchJson<T>(
      fillTemplate(request.url, fields),
      { method: request.method, headers, body: body ? JSON.stringify(body) : undefined },
      { signal: controller.signal, label: 'ops', maxRetries: MAX_RETRIES },
    );
  } finally {
    clearTimeout(timer);
  }
}
