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
import { fillTemplate } from './pipeline/run.js';
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

/** Fill `{{field}}` placeholders throughout a value, however deeply nested. */
export function fillDeep(value: unknown, fields: Fields): unknown {
  if (typeof value === 'string') return fillTemplate(value, fields);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, fields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, fields)]));
  }
  return value;
}

/** Perform the request a definition describes, with `fields` filled in. */
export async function runHttpRequest<T = unknown>(
  request: HttpRequestDef,
  fields: Fields,
  credentials?: CredentialStore,
): Promise<T> {
  const headers: Record<string, string> = { ...(fillDeep(request.headers, fields) as Record<string, string>) };

  if (request.credential && credentials) {
    const secret = await credentials.get(request.credential as CredentialRef);
    if (secret) headers.authorization ??= `Bearer ${secret}`;
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
