/**
 * Fetching the input at processing time, from the user's own API.
 *
 * The event carries an identifier, not the data (D6). A message can sit in a queue for a
 * while, and whatever it describes can change while it waits — acting on a copy that
 * travelled with the event means acting on yesterday's record. So the record is read now.
 *
 * One HTTP call covers REST, GraphQL and in-house APIs alike (D7): GraphQL is a POST with
 * a JSON body, and `select` reads out of `data.…` the same way it reads out of anything
 * else. A database adapter per storage engine is what this avoids.
 */
import { HttpError } from '../../core/fetch-retry.js';
import type { CredentialStore } from '../../credentials/types.js';
import { runHttpRequest } from '../http.js';
import type { InputResolver, ResolvedInput } from '../pipeline/ports.js';
import type { PipelineInput } from '../pipeline/schema.js';
import { applySelect } from './none.js';

/**
 * The thing the event pointed at is not there.
 *
 * Separate from a failed fetch on purpose: a 503 may well work in a minute, while a 404
 * will answer the same way forever. The lifecycle turns one into a retry and the other
 * into a skip, and a queue that could not tell them apart would redeliver a deleted
 * record until its dead-letter policy gave up.
 */
export class TargetMissingError extends Error {
  constructor(url: string) {
    super(`nothing at ${url} — the record it pointed to is gone`);
    this.name = 'TargetMissingError';
  }
}

export class HttpInputResolver implements InputResolver {
  readonly kind = 'http' as const;

  constructor(private readonly credentials?: CredentialStore) {}

  async resolve(input: PipelineInput, event: unknown): Promise<ResolvedInput> {
    if (input.kind !== 'http') throw new Error('HttpInputResolver given a non-http input');

    // The event's own fields fill the URL and body templates — that is how an identifier
    // becomes a request.
    const from = (event ?? {}) as Record<string, unknown>;

    let raw: unknown;
    try {
      raw = await runHttpRequest(input.request, from, this.credentials);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
        throw new TargetMissingError(input.request.url);
      }
      throw err;
    }

    // With no `select`, the response IS the input — the shortest path from an API that
    // already returns a flat object to a working pipeline.
    const fields = Object.keys(input.select).length
      ? applySelect(raw, input.select)
      : ((raw ?? {}) as Record<string, unknown>);

    return { raw, fields };
  }
}
