/**
 * Common HTTP wrapper for every external API call. Handles the rate-limit and
 * transient-failure rules each provider needs:
 *   - 429: honor Retry-After (seconds or HTTP date); fall back to backoff.
 *   - GitHub 403 + x-ratelimit-remaining:0 : wait until x-ratelimit-reset.
 *   - 5xx: exponential backoff (capped).
 *
 * Lifted from upstream.
 */
import { logger } from './logger.js';

export interface FetchRetryOptions {
  maxRetries?: number;
  /** Base backoff in ms (doubles each attempt). */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  signal?: AbortSignal;
  label?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error('aborted'));
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new Error('aborted'));
    });
  });

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // GitHub primary rate limit: 403/429 with remaining 0 + reset epoch (seconds).
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (!Number.isNaN(reset)) return Math.max(0, reset * 1000 - Date.now());
  }
  return null;
}

/** fetch + automatic retry. Returns the successful Response (caller reads the body). */
export async function fetchRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const { maxRetries = 5, baseBackoffMs = 1_000, maxBackoffMs = 30_000, signal, label = 'http' } = opts;

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: signal ?? init.signal });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const wait = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
      logger.warn(`${label}: network error, retrying in ${wait}ms`, String(err));
      await sleep(wait, signal);
      attempt++;
      continue;
    }

    if (res.ok) return res;

    // 403 is retryable ONLY when it's a rate limit (GitHub) — a permission 403
    // (e.g. Notion "restricted_resource") won't change on retry, so fail fast.
    const rateLimited403 =
      res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || Boolean(res.headers.get('retry-after')));
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600) || rateLimited403;
    if (!retryable || attempt >= maxRetries) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, body);
    }

    const explicit = retryAfterMs(res);
    const wait = explicit ?? Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
    logger.warn(`${label}: HTTP ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
    await res.body?.cancel().catch(() => {});
    await sleep(wait, signal);
    attempt++;
  }
}

/** fetchRetry + JSON parse. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, opts: FetchRetryOptions = {}): Promise<T> {
  const res = await fetchRetry(url, init, opts);
  return (await res.json()) as T;
}
