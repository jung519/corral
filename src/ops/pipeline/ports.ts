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

export interface OperationResult {
  /** The structured answer, already shaped by the step's schema. */
  answer: Record<string, unknown>;
  /** Tokens spent, for the shared ceiling (D11/D12). */
  tokens?: number;
}

/** One structured-output turn (CRL-13). */
export interface OperationRunner {
  run(step: PipelineAgentStep, fields: Fields): Promise<OperationResult>;
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
  check(step: PipelineAgentStep, answer: Record<string, unknown>): Promise<ValidationVerdict>;
}

/** Delivers the result to the user's system (CRL-20). */
export interface OutputSink {
  readonly kind: PipelineOutput['kind'];
  send(output: PipelineOutput, fields: Fields): Promise<void>;
}
