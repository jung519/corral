/**
 * Lists a pipeline names, fetched once and reused for a few minutes.
 *
 * Two places want the same list and used to reach it separately — the prompt has to say
 * "choose from these" before the turn, and the answer check has to compare against them
 * after it. The fetch and its cache lived inside `RuleAnswerValidator`, which the runners
 * have no way to reach, so a list could only ever be used at the checking end (CRL-64).
 *
 * Now one of these is built in `ops-host.ts` and handed to both. That is not only tidier:
 * it is what makes "the list the model was shown is the list its answer was judged
 * against" true rather than probable.
 *
 * **The list comes back as it arrived.** A `Set` is what a membership test wants and an
 * ordered list is what a prompt wants, so the shared thing is the plainer of the two and
 * the check builds its own `Set`. Tidying is also not done here — see `ContextSourceSchema`.
 */
import { readPath } from '../pipeline/run.js';
import { runHttpRequest } from '../http.js';
import type { CredentialStore } from '../../credentials/types.js';
import type { HttpRequestDef } from '../pipeline/schema.js';

/**
 * How long a fetched list is reused.
 *
 * A list that changes daily does not need fetching thousands of times a day, and one that
 * is minutes stale is not a hazard — the answer check drops anything that is no longer on
 * it either way.
 */
export const CONTEXT_TTL_MS = 5 * 60_000;

/** What a definition can say about where a list comes from. `allowed_values` fits too. */
export interface ListSpec {
  values?: readonly unknown[];
  source?: HttpRequestDef;
  select?: string;
}

export interface ContextStoreOptions {
  credentials?: CredentialStore;
  /** Injectable so tests don't depend on wall-clock. */
  now?: () => number;
  ttlMs?: number;
}

export class ContextStore {
  private readonly cache = new Map<string, { at: number; values: unknown[] }>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: ContextStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? CONTEXT_TTL_MS;
  }

  /** The list, inline or fetched. Throws when it cannot be had — a caller that guessed
   *  instead would defeat the point of having named a source. */
  async list(spec: ListSpec): Promise<unknown[]> {
    if (spec.values) return [...spec.values];
    if (!spec.source) throw new Error('no values and no source'); // the schema rejects this shape

    // Keyed by the request, not by the name a pipeline gave it: two pipelines pointing at
    // the same endpoint are asking the same question and should cost one call.
    const key = `${spec.source.method} ${spec.source.url}${spec.select ? `#${spec.select}` : ''}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.values;

    const body = await runHttpRequest<unknown>(spec.source, {}, this.options.credentials);
    const raw = spec.select ? readPath(body, spec.select) : body;
    if (!Array.isArray(raw)) throw new Error(`expected a list${spec.select ? ` at "${spec.select}"` : ''}`);

    this.cache.set(key, { at: this.now(), values: raw });
    return raw;
  }
}
