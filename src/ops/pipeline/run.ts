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
import type { AnswerValidator, Fields, InputResolver, OperationRunner, OutputSink } from './ports.js';
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

/**
 * Where a pipeline's code-written steps come from.
 *
 * Consulted per run, before the built-in adapter. Everything around the step — the budget
 * check, `skip_if`, `require`, the outcome, the history record — is unchanged, which is
 * the point: a plugin replaces one step, not the rules.
 */
export interface PluginSteps {
  input(pipeline: Pipeline): Promise<InputResolver | undefined>;
  operation(pipeline: Pipeline): Promise<OperationRunner | undefined>;
  validator(pipeline: Pipeline): Promise<AnswerValidator | undefined>;
  sink(pipeline: Pipeline): Promise<OutputSink | undefined>;
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
  /** Code-written steps. Absent = declarative only. */
  plugins?: PluginSteps;
  /** Injectable so tests are deterministic. */
  now?: () => number;
}

/** `{{field}}` → value. Unknown names become empty rather than leaking the placeholder. */
export function fillTemplate(template: string, fields: Fields): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
    const value = fields[name];
    return value === undefined || value === null ? '' : String(value);
  });
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
      let resolved;
      try {
        // A plugin wins where one is named; a failure to load it is an input failure like
        // any other, reported with its reason rather than swallowed.
        const resolver = (await this.deps.plugins?.input(pipeline)) ?? this.deps.resolvers.get(pipeline.input.kind);
        if (!resolver) {
          return done('input_failed', { stage: 'input', reason: `no resolver for input kind "${pipeline.input.kind}"` });
        }
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

      // ── the two reasons not to spend a turn ──────────────────────────────────
      const { skip_if: skipIf, require } = pipeline.input;
      if (skipIf && conditionHolds(skipIf, resolved.raw)) {
        // The defence against processing the same thing twice. Queues redeliver, and a
        // redelivery must not cost a second turn or overwrite a good answer.
        return done('skipped', { stage: 'input', reason: `skip_if matched (${skipIf.field} is ${skipIf.is})` });
      }
      const missing = require.filter((name) => isEmpty(resolved.fields[name]));
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
      let operation;
      try {
        // A step written in code that cannot be built is a failure of that step, reported
        // like any other — never a crash that loses the run record.
        const runner = (await this.deps.plugins?.operation(pipeline)) ?? this.deps.operation;
        operation = await runner.run(pipeline.agent, resolved.fields);
      } catch (err) {
        return done('agent_failed', { stage: 'agent', reason: message(err) });
      }
      // Spent whatever the answer turns out to be worth — a rejected answer still cost
      // tokens, and a ceiling that only counted useful calls would not be a ceiling.
      this.deps.budget?.record({ inputTokens: operation.inputTokens ?? 0, outputTokens: operation.outputTokens ?? 0 });

      // ── checking the answer ──────────────────────────────────────────────────
      let verdict;
      try {
        const checker = (await this.deps.plugins?.validator(pipeline)) ?? this.deps.validator;
        verdict = await checker.check(pipeline.agent, operation.answer);
      } catch (err) {
        // Refused, not passed. Same reasoning as a vocabulary that cannot be fetched: with
        // no way to tell a good answer from a bad one, letting it through would defeat the
        // check at exactly the moment it matters.
        return done('rejected', { stage: 'validate', reason: message(err) });
      }
      // Everything the turn cost, carried to whichever ending this run reaches.
      const spend = {
        tokens: operation.tokens,
        inputTokens: operation.inputTokens,
        outputTokens: operation.outputTokens,
        costUsd: operation.costUsd,
        provider: operation.provider,
        model: operation.model,
        failedOver: operation.failedOver,
      };

      let answer: Record<string, unknown>;
      let dropped: string[] | undefined;
      let reviewUrl: string | undefined;
      let lowConfidence: boolean | undefined;

      if (verdict.ok) {
        answer = verdict.answer;
        dropped = verdict.dropped;
      } else if ('lowConfidence' in verdict) {
        const fields = { ...resolved.fields, ...verdict.answer };
        reviewUrl = pipeline.on_low_confidence.review_url
          ? fillTemplate(pipeline.on_low_confidence.review_url, fields)
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
      try {
        const sink = (await this.deps.plugins?.sink(pipeline)) ?? this.deps.sinks.get(pipeline.output.kind);
        if (!sink) {
          return done('output_failed', { stage: 'output', reason: `no sink for output kind "${pipeline.output.kind}"`, ...spend, lowConfidence });
        }
        await sink.send(pipeline.output, { ...resolved.fields, ...answer });
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
