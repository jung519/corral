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
import { ContextStore, CONTEXT_TTL_MS, type ContextStoreOptions } from '../context/store.js';
import type { AnswerValidator, ValidationVerdict } from '../pipeline/ports.js';
import type { PipelineAgentStep, PipelineValidation } from '../pipeline/schema.js';

/** Kept as the name this file has always exported. The value, and the reasoning behind
 *  it, moved to the store when the fetch did (CRL-64). */
export const VOCABULARY_TTL_MS = CONTEXT_TTL_MS;

export interface RuleValidatorOptions extends ContextStoreOptions {
  /** The host's shared store. Omit and this builds one from the options above. */
  store?: ContextStore;
}

export class RuleAnswerValidator implements AnswerValidator {
  private readonly store: ContextStore;

  /** Pass the host's store so the prompt and the check read one fetch. Left to build its
   *  own only for tests that exercise this class alone. */
  constructor(options: RuleValidatorOptions = {}) {
    this.store = options.store ?? new ContextStore(options);
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
        const outside: string[] = [];
        const kept = asList(value).filter((v) => {
          if (allowed.has(v)) return true;
          outside.push(v);
          dropped.push(`${field}: ${v}`); // recorded, so an operator can see the model drifting
          return false;
        });
        result[field] = Array.isArray(value) ? kept : (kept[0] ?? null);

        // Nothing the model offered survived, so the field is empty and there is nothing to
        // send. Refused rather than passed on, for the same reason a list of records is
        // refused above rather than emptied: an empty value delivered as a completed run is
        // the outcome this rule exists to prevent, and it is the one an operator would never
        // think to look for. Some dropped and some kept is progress and stays a success
        // (CRL-63).
        //
        // An answer that arrived empty is not this. The prompt tells the model to return an
        // empty list when it has no grounds, and honouring that instruction is not drift.
        if (kept.length === 0 && outside.length > 0) {
          return {
            ok: false,
            reasons: [`every value for "${field}" was outside the allowed list — dropped: ${outside.join(', ')}`],
          };
        }
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

  /**
   * The allowed list, as a set to test membership against.
   *
   * The fetching and the caching are the store's now, shared with whatever put the same
   * list in the prompt (CRL-64). A `Set` is built here because that is what this end of
   * the turn wants; the store keeps the plainer list the prompt wants.
   */
  private async vocabulary(rule: NonNullable<PipelineValidation['allowed_values']>): Promise<Set<string>> {
    return new Set((await this.store.list(rule)).map((v) => String(v)));
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
