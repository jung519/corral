/**
 * One run of one pipeline: event in → input → model → check → output.
 *
 * The unit here is a **run**, not an issue. The development AI thinks in issues that live
 * for hours and change phase; an operational run is a few seconds long, happens thousands
 * of times, and either delivered something or didn't.
 *
 * Two things this file is strict about:
 *
 * **A run says which step failed.** "It didn't work" is useless when the same pipeline
 * fires all night — an unreachable source, a model error, an answer that broke a rule and
 * a rejected write are four different problems with four different fixes.
 *
 * **The model is called last, and only if it should be.** Fetching is cheap, a turn is
 * not. `skip_if` and `require` are both checked *before* the call, so a redelivered event
 * for something already handled costs a fetch, not a turn.
 */
import { bus } from '../../core/events.js';
import { ConcurrencyLimiter } from '../../core/concurrency-limiter.js';
import type { BudgetVerdict, TokenUsage } from '../../core/token-budget.js';
import type { AnswerValidator, Fields, InputResolver, OperationOutcome, OperationRunner, OutputSink } from './ports.js';
import type { Condition, Pipeline } from './schema.js';

/** Where a run stopped. Everything except `completed` and `skipped` is a failure. */
export type RunOutcome =
  | 'completed'
  /** Deliberately not processed — `skip_if` matched, or a required field was absent. */
  | 'skipped'
  /** Held back for review instead of written (`on_low_confidence: report`). */
  | 'reported'
  /** The pipeline was already at its concurrency limit; nothing was attempted. */
  | 'throttled'
  /** The day's shared token ceiling is spent; nothing was attempted. */
  | 'over_budget'
  | 'input_failed'
  | 'agent_failed'
  | 'rejected'
  | 'output_failed';

export type RunStage = 'input' | 'agent' | 'validate' | 'output';

export interface RunRecord {
  id: string;
  pipeline: string;
  startedAt: number;
  endedAt: number;
  outcome: RunOutcome;
  /** The step that ended the run. Absent when it completed. */
  stage?: RunStage;
  /** Why, in the operator's terms. */
  reason?: string;
  /** Values the validator discarded (out-of-vocabulary answers, overlong lists). */
  dropped?: string[];
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The provider that actually answered, and whether it was the second choice. */
  provider?: string;
  model?: string;
  failedOver?: boolean;
  /** The answer came back under the confidence threshold. Recorded separately from the
   *  outcome because `on_low_confidence` can turn the same fact into three different
   *  endings — without this flag, a low-confidence skip is indistinguishable from a
   *  `skip_if` skip and the daily count would be wrong. */
  lowConfidence?: boolean;
  /** Deep link for a human to look at, on a held-back result (D14). */
  reviewUrl?: string;
}

/** The slice of the shared ceiling a run touches. `TokenBudget` satisfies it. */
export interface RunBudget {
  check(): BudgetVerdict;
  record(usage: TokenUsage): void;
}

export interface RunDeps {
  /** By `input.kind`. */
  resolvers: Map<string, InputResolver>;
  operation: OperationRunner;
  validator: AnswerValidator;
  /** By `output.kind`. */
  sinks: Map<string, OutputSink>;
  /** Daily token ceiling, shared with the development AI. Narrowed to what a run needs,
   *  so the host can hand over a read-through view without casting. */
  budget?: RunBudget;
  /** Injectable so tests are deterministic. */
  now?: () => number;
}

/** A template that is nothing but one placeholder, e.g. `"{{items}}"`. */
const SOLE_PLACEHOLDER = /^\{\{\s*([\w.]+)\s*\}\}$/;
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * `{{field}}` → text. Unknown names become empty rather than leaking the placeholder.
 *
 * A list or a record is written as JSON. `String(value)` would hand the model
 * `[object Object],[object Object]` — the field is in the prompt, the data is not, and
 * nothing says so.
 */
export function fillTemplate(template: string, fields: Fields): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const value = fields[name];
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/**
 * The same substitution where the result does not have to be text — an output body, a
 * message to publish.
 *
 * A template that is *only* a placeholder yields the value itself. `{ labels: "{{items}}" }`
 * has to reach the user's API as a list; text is the one thing it must not become, and
 * their API is the wrong place to find that out.
 *
 * Anything with text around the placeholder is still text, because that is what it was
 * asked to be.
 *
 * A field that isn't there sends `null`, not `""` — an empty string is a value, and a
 * receiver has no way to tell it from one the model actually produced.
 */
export function fillValue(template: string, fields: Fields): unknown {
  const sole = SOLE_PLACEHOLDER.exec(template);
  if (sole) {
    const value = fields[sole[1] as string];
    return value === undefined ? null : value;
  }
  return fillTemplate(template, fields);
}

/** Read a dotted path out of a parsed document. */
export function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, source);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function conditionHolds(condition: Condition, source: unknown): boolean {
  const empty = isEmpty(readPath(source, condition.field));
  return condition.is === 'empty' ? empty : !empty;
}

/**
 * Runs pipelines. One instance owns the per-pipeline concurrency slots, so the limit is
 * enforced across every trigger that can start a run — a scheduled tick and a queue
 * message contend for the same slots rather than each getting their own allowance.
 */
export class PipelineRunner {
  private readonly limiters = new Map<string, ConcurrencyLimiter>();
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** In-flight runs for a pipeline. */
  activeCount(key: string): number {
    return this.limiters.get(key)?.activeCount ?? 0;
  }

  private limiterFor(p: Pipeline): ConcurrencyLimiter {
    let limiter = this.limiters.get(p.key);
    if (!limiter) {
      limiter = new ConcurrencyLimiter(p.max_concurrent);
      this.limiters.set(p.key, limiter);
    }
    return limiter;
  }

  private emit(record: Pick<RunRecord, 'id' | 'pipeline'>, stage: RunStage | 'run', label: string, data?: Record<string, unknown>): void {
    bus.emitEvent({
      identifier: record.id,
      kind: stage === 'run' ? 'run' : 'phase',
      label,
      phase: stage,
      data: { pipeline: record.pipeline, ...data },
    });
  }

  async run(pipeline: Pipeline, event: unknown): Promise<RunRecord> {
    const id = `${pipeline.key}-${this.now()}-${++this.seq}`;
    const startedAt = this.now();
    const head = { id, pipeline: pipeline.key };
    const done = (outcome: RunOutcome, rest: Partial<RunRecord> = {}): RunRecord => {
      const record: RunRecord = { ...head, startedAt, endedAt: this.now(), outcome, ...rest };
      this.emit(head, 'run', `run ${outcome}`, { outcome, stage: record.stage, reason: record.reason });
      return record;
    };

    const limiter = this.limiterFor(pipeline);
    // Refused, not queued: the caller knows how its trigger should react (leave the
    // message unacknowledged, skip this tick), and this runner has no business holding a
    // backlog it would lose on restart.
    if (!limiter.tryAcquire(id)) {
      return done('throttled', { reason: `already running ${limiter.activeCount}/${limiter.capacity}` });
    }

    try {
      this.emit(head, 'run', 'run started');

      // ── input ────────────────────────────────────────────────────────────────
      const resolver = this.deps.resolvers.get(pipeline.input.kind);
      if (!resolver) {
        return done('input_failed', { stage: 'input', reason: `no resolver for input kind "${pipeline.input.kind}"` });
      }
      let resolved;
      try {
        resolved = await resolver.resolve(pipeline.input, event);
      } catch (err) {
        // "Gone" is not "broken". A deleted record answers the same way forever, so this
        // is a conclusion, not a failure — and a queue told otherwise would redeliver it
        // until its dead-letter policy gave up.
        if (err instanceof Error && err.name === 'TargetMissingError') {
          return done('skipped', { stage: 'input', reason: message(err) });
        }
        return done('input_failed', { stage: 'input', reason: message(err) });
      }

      // What arrived, plus what was read because of it. A pubsub event carries the
      // identifier and a scheduled tick carries the time, and both are gone the moment
      // `select` names paths in the *response* — leaving `{{id}}` in the output URL to
      // render as nothing at all. Selected names win, so a `select` still decides what a
      // name means.
      const fields = { ...asFields(event), ...resolved.fields };

      // ── the two reasons not to spend a turn ──────────────────────────────────
      const { skip_if: skipIf, require } = pipeline.input;
      if (skipIf && conditionHolds(skipIf, resolved.raw)) {
        // The defence against processing the same thing twice. Queues redeliver, and a
        // redelivery must not cost a second turn or overwrite a good answer.
        return done('skipped', { stage: 'input', reason: `skip_if matched (${skipIf.field} is ${skipIf.is})` });
      }
      const missing = require.filter((name) => isEmpty(fields[name]));
      if (missing.length) {
        // Skipped, not failed: the source genuinely lacks the field, so retrying fetches
        // the same gap. Treating it as an error would retry forever.
        return done('skipped', { stage: 'input', reason: `missing required field(s): ${missing.join(', ')}` });
      }

      // ── the model turn ───────────────────────────────────────────────────────
      // The ceiling is shared with the development AI, so this can be spent by work that
      // has nothing to do with pipelines. Its own outcome, not a failure: a failed run
      // invites the trigger to redeliver, and redelivering into a spent budget all day
      // is exactly the retry storm to avoid. There is nothing to fix until tomorrow.
      const allowed = this.deps.budget?.check();
      if (allowed && !allowed.ok) {
        return done('over_budget', { stage: 'agent', reason: allowed.reason });
      }

      this.emit(head, 'agent', 'calling the model');
      let operation: OperationOutcome;
      try {
        operation = await this.deps.operation.run(pipeline.agent, fields);
      } catch (err) {
        // The runner broke its own contract — a bug, not a failed turn. Nobody knows what
        // it spent, and zero is the honest answer to a question nobody can answer. Every
        // failure the runner *does* know about comes back as `ok: false` below, with its
        // bill attached.
        return done('agent_failed', { stage: 'agent', reason: message(err) });
      }
      // Spent whatever the answer turns out to be worth — a rejected answer still cost
      // tokens, and a ceiling that only counted useful calls would not be a ceiling.
      //
      // Recorded *above* the success/failure branch on purpose (CRL-44). It used to sit
      // below a `return` for the failure path, so a pipeline whose model never matched the
      // schema billed all day against a ceiling reading zero — the spend control bypassed
      // by the shape of the code rather than by any decision.
      this.deps.budget?.record({ inputTokens: operation.inputTokens ?? 0, outputTokens: operation.outputTokens ?? 0 });

      // What the turn cost, carried to whichever ending this run reaches — including the
      // endings where there is no answer to show for it.
      const cost = {
        tokens: operation.tokens,
        inputTokens: operation.inputTokens,
        outputTokens: operation.outputTokens,
        costUsd: operation.costUsd,
      };
      if (!operation.ok) {
        return done('agent_failed', { stage: 'agent', reason: operation.reason, ...cost });
      }
      // Which provider answered only exists once one did.
      const spend = { ...cost, provider: operation.provider, model: operation.model, failedOver: operation.failedOver };

      // ── checking the answer ──────────────────────────────────────────────────
      const verdict = await this.deps.validator.check(pipeline.agent, operation.answer);

      let answer: Record<string, unknown>;
      let dropped: string[] | undefined;
      let reviewUrl: string | undefined;
      let lowConfidence: boolean | undefined;

      if (verdict.ok) {
        answer = verdict.answer;
        dropped = verdict.dropped;
      } else if ('lowConfidence' in verdict) {
        const withAnswer = { ...fields, ...verdict.answer };
        reviewUrl = pipeline.on_low_confidence.review_url
          ? fillTemplate(pipeline.on_low_confidence.review_url, withAnswer)
          : undefined;
        const reason = verdict.reasons.join('; ');
        lowConfidence = true;
        // `report` is the default for a reason: a doubtful answer written into someone's
        // system is worse than no answer, and a human can only look if we say where.
        if (pipeline.on_low_confidence.action === 'report') {
          return done('reported', { stage: 'validate', reason, ...spend, lowConfidence, reviewUrl });
        }
        if (pipeline.on_low_confidence.action === 'skip') {
          return done('skipped', { stage: 'validate', reason, ...spend, lowConfidence });
        }
        answer = verdict.answer;
      } else {
        return done('rejected', { stage: 'validate', reason: verdict.reasons.join('; '), ...spend });
      }

      // ── output ───────────────────────────────────────────────────────────────
      const sink = this.deps.sinks.get(pipeline.output.kind);
      if (!sink) {
        return done('output_failed', { stage: 'output', reason: `no sink for output kind "${pipeline.output.kind}"`, ...spend, lowConfidence });
      }
      try {
        await sink.send(pipeline.output, { ...fields, ...answer });
      } catch (err) {
        // The turn is already spent, so this is the expensive failure — it has to be
        // distinguishable from the cheap ones when someone reads the history.
        return done('output_failed', { stage: 'output', reason: message(err), ...spend, dropped, lowConfidence });
      }

      return done('completed', { ...spend, dropped, reviewUrl, lowConfidence });
    } finally {
      limiter.release(id);
    }
  }
}

/** An event is whatever the trigger handed over; only an object contributes names. */
function asFields(event: unknown): Fields {
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as Fields) : {};
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
