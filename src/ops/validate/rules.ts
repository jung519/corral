/**
 * Checking the answer in code, whatever the prompt asked for.
 *
 * The prompt already says "at most four" and "only these values". This checks it again,
 * because a prompt is a request and the model's compliance is not a guarantee — and the
 * day someone switches models is the day that becomes obvious. The pipeline's output goes
 * into somebody's live system; the last thing standing between a bad answer and that
 * system should be code, not wording.
 *
 * Everything here is domain-neutral: counts, membership, a number against a threshold.
 * Nothing knows what the values mean.
 */
import { logger } from '../../core/logger.js';
import type { CredentialStore } from '../../credentials/types.js';
import { runHttpRequest } from '../http.js';
import type { AnswerValidator, ValidationVerdict } from '../pipeline/ports.js';
import { readPath } from '../pipeline/run.js';
import type { PipelineAgentStep, PipelineValidation } from '../pipeline/schema.js';

/** How long a fetched vocabulary is reused. A list that changes daily doesn't need
 *  fetching thousands of times a day, and a stale-by-minutes list is not a hazard. */
export const VOCABULARY_TTL_MS = 5 * 60_000;

export interface RuleValidatorOptions {
  credentials?: CredentialStore;
  /** Injectable so tests don't depend on wall-clock. */
  now?: () => number;
  ttlMs?: number;
}

export class RuleAnswerValidator implements AnswerValidator {
  private readonly cache = new Map<string, { at: number; values: Set<string> }>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: RuleValidatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? VOCABULARY_TTL_MS;
  }

  async check(step: PipelineAgentStep, answer: Record<string, unknown>): Promise<ValidationVerdict> {
    const rules: PipelineValidation = step.validate;
    const result = { ...answer };
    const dropped: string[] = [];

    // ── values outside the allowed list ──────────────────────────────────────────
    if (rules.allowed_values) {
      const { field } = rules.allowed_values;
      const value = result[field];
      if (value !== undefined) {
        // The load-time check catches this whenever the answer schema declares a type.
        // It often doesn't — `{ type: array }` says nothing about what is inside — so the
        // first look at a real value is here. Comparing a record against a list of names
        // can only ever say "not in the list", which would empty the field and report
        // success: the pipeline would go on publishing nothing, forever, as a completed run.
        if (!isComparable(value)) {
          return {
            ok: false,
            reasons: [`"${field}" is not a value allowed_values can compare — it holds ${describe(value)}`],
          };
        }
        let allowed: Set<string>;
        try {
          allowed = await this.vocabulary(rules.allowed_values);
        } catch (err) {
          // Without the list there is no way to tell a good value from a bad one, and
          // guessing would defeat the rule. Refuse rather than pass it through.
          return { ok: false, reasons: [`could not load the allowed values for "${field}": ${message(err)}`] };
        }
        const kept = asList(value).filter((v) => {
          if (allowed.has(v)) return true;
          dropped.push(`${field}: ${v}`); // recorded, so an operator can see the model drifting
          return false;
        });
        result[field] = Array.isArray(value) ? kept : (kept[0] ?? null);
      }
    }

    // ── more items than asked for ────────────────────────────────────────────────
    if (rules.max_items) {
      const { field, limit } = rules.max_items;
      const value = result[field];
      if (Array.isArray(value) && value.length > limit) {
        for (const extra of value.slice(limit)) dropped.push(`${field}: ${String(extra)}`);
        result[field] = value.slice(0, limit);
      }
    }

    if (dropped.length) logger.warn(`ops: dropped ${dropped.length} value(s) the model should not have returned`);

    // ── the model's own confidence ───────────────────────────────────────────────
    if (rules.min_confidence) {
      const { field, threshold } = rules.min_confidence;
      const value = result[field];
      if (typeof value !== 'number') {
        // The pipeline asked for a confidence check and there is no number to check.
        // Treating that as "confident enough" would silently disable the rule.
        return { ok: false, reasons: [`"${field}" is not a number, so the confidence rule cannot be applied`] };
      }
      if (value < threshold) {
        // Not a rejection: the answer is well-formed, just doubtful. What happens next is
        // the pipeline's `on_low_confidence` decision, not this validator's.
        return {
          ok: false,
          lowConfidence: true,
          reasons: [`${field} ${value} is below the ${threshold} threshold`],
          answer: result,
        };
      }
    }

    return { ok: true, answer: result, dropped: dropped.length ? dropped : undefined };
  }

  /** The allowed list — inline, or fetched and briefly cached. */
  private async vocabulary(rule: NonNullable<PipelineValidation['allowed_values']>): Promise<Set<string>> {
    if (rule.values) return new Set(rule.values);
    if (!rule.source) throw new Error('no values and no source'); // the schema rejects this shape

    const key = `${rule.source.method} ${rule.source.url}${rule.select ? `#${rule.select}` : ''}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.values;

    const body = await runHttpRequest<unknown>(rule.source, {}, this.options.credentials);
    const raw = rule.select ? readPath(body, rule.select) : body;
    if (!Array.isArray(raw)) throw new Error(`expected a list${rule.select ? ` at "${rule.select}"` : ''}`);

    const values = new Set(raw.map((v) => String(v)));
    this.cache.set(key, { at: this.now(), values });
    return values;
  }
}

/** Treat a single value as a one-item list, so a rule works either way. */
function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return value === null || value === undefined ? [] : [String(value)];
}

/** A name, or a list of names. Anything a vocabulary could sensibly hold. */
function isComparable(value: unknown): boolean {
  const scalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  return Array.isArray(value) ? value.every(scalar) : scalar(value);
}

/** What it holds instead, in the operator's terms. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return 'a list with something other than names in it';
  return 'a record';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
