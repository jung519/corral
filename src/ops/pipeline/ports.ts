/**
 * What a run needs from the outside world.
 *
 * The lifecycle (run.ts) decides the order of things, what counts as a failure, and what
 * must never happen — the four steps below decide *how* each piece of work is actually
 * done, and land in their own issues. Keeping them behind these interfaces means the
 * lifecycle can be built and tested now, with no HTTP, no queue and no model call.
 *
 * The split is deliberate about one thing: **policy is not in here.** `require` and
 * `skip_if` are enforced by the lifecycle, not by resolvers, so "don't call the model
 * twice for the same event" is one rule in one place rather than a promise each adapter
 * has to keep.
 */
import type { PipelineAgentStep, PipelineInput, PipelineOutput } from './schema.js';

/** Flat field bag handed to prompts and templates. */
export type Fields = Record<string, unknown>;

export interface ResolvedInput {
  /** The untouched source document. `skip_if` reads paths out of this. */
  raw: unknown;
  /** `select`ed values, the names the prompt template uses. */
  fields: Fields;
}

/** Turns an incoming event into model input (CRL-19). */
export interface InputResolver {
  readonly kind: PipelineInput['kind'];
  resolve(input: PipelineInput, event: unknown): Promise<ResolvedInput>;
}

/**
 * What a turn cost, however it ended.
 *
 * Its own type because failure has to carry it too (CRL-44). A provider that answered has
 * already billed for the answer, whether or not the answer was usable — so the numbers
 * below are the whole turn's, summed across every provider tried, not just the one that
 * happened to work.
 */
/**
 * Fetches what a step's `context` declares, before the turn (CRL-64).
 *
 * Its own port rather than a job for the input resolver: an input answers "what is this
 * run about" and there is one of them, while context answers "what are the choices" and
 * there can be several. Folding them together would have made the single input slot carry
 * two unrelated kinds of thing.
 */
export interface ContextResolver {
  /** Name → value, ready to merge into the field bag. Throws when a list cannot be had. */
  resolve(step: PipelineAgentStep): Promise<Fields>;
}

export interface OperationSpend {
  /** Tokens spent — THE unit for the shared ceiling (D11/D12). */
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** What it cost, if the runner worked it out (`agent/pricing.ts`). Informational only:
   *  vendors change prices, which is exactly why the ceiling counts tokens instead. */
  costUsd?: number;
}

export interface OperationResult extends OperationSpend {
  /** The structured answer, already shaped by the step's schema. */
  answer: Record<string, unknown>;
  /** Which provider actually answered — not necessarily the one the pipeline named, and
   *  the whole point of recording it. */
  provider?: string;
  model?: string;
  /** The first provider failed and another took over. */
  failedOver?: boolean;
}

/**
 * How a turn ended, and what it cost either way.
 *
 * A union rather than "throw on failure", because the ceiling has to count a failed turn
 * (CRL-44). An exception carrying usage would leave the catch unable to tell "this spent
 * nothing" from "whoever threw forgot to attach it" — and the second one reads as zero,
 * which is exactly the bug. Here a runner cannot report a failure without saying what it
 * spent, because the type has nowhere else to put it.
 *
 * Runners still throw for their own bugs. That path records zero, and zero is honest
 * there: nobody knows what a crashed runner spent.
 */
export type OperationOutcome = ({ ok: true } & OperationResult) | ({ ok: false; reason: string } & OperationSpend);

/** One structured-output turn (CRL-13). */
export interface OperationRunner {
  run(step: PipelineAgentStep, fields: Fields): Promise<OperationOutcome>;
}

export type ValidationVerdict =
  | { ok: true; answer: Record<string, unknown>; dropped?: string[] }
  /** The answer broke a rule outright — nothing is sent on. */
  | { ok: false; reasons: string[] }
  /** The answer is well-formed but under the confidence threshold; what happens next is
   *  the pipeline's `on_low_confidence` decision, not the validator's. */
  | { ok: false; lowConfidence: true; reasons: string[]; answer: Record<string, unknown> };

/** Checks the answer in code, whatever the prompt asked for (CRL-15). */
export interface AnswerValidator {
  /**
   * `context` is what the prompt was given, **before** it was merged into the field bag.
   *
   * Before, because a context name is the weakest in that bag: an event field of the same
   * name wins there, and a check reading the merged version could end up treating a value
   * that arrived on a queue message as the controlled vocabulary. What the model was shown
   * is the only list its answer can fairly be judged against (CRL-66).
   */
  check(step: PipelineAgentStep, answer: Record<string, unknown>, context: Fields): Promise<ValidationVerdict>;
}

/** Delivers the result to the user's system (CRL-20). */
export interface OutputSink {
  readonly kind: PipelineOutput['kind'];
  send(output: PipelineOutput, fields: Fields): Promise<void>;
}
