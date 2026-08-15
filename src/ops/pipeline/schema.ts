/**
 * Pipeline definition — the declarative shape of one operational-AI job.
 *
 *   trigger → input → agent → output
 *
 * Every name here is domain-neutral on purpose. Corral knows *kinds* of things (a queue,
 * an HTTP call, a structured answer); what a `title` or a `category` means belongs to the
 * user's system, and never to this schema. If a field name would only make sense for one
 * kind of business, it does not belong here.
 *
 * This is also the contract for everything downstream (registry, runtime, history, UI),
 * and — per D10 — deliberately a *subset* of what a code plugin will be able to do. A
 * declarative pipeline must never be able to express something a code operation cannot.
 */
import { z } from 'zod';
import { CredentialRefSchema } from '../../config/schema.js';

/**
 * Where a value comes from in a JSON response: a dotted path, optionally truncated.
 * Long free text blows up prompt cost, so the truncation lives in the definition rather
 * than in whatever prompt the user happens to write.
 */
export const FieldSelectorSchema = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), truncate: z.number().int().positive().optional() }),
]);

/** A structured condition. Free-text conditions can't be executed, so there aren't any. */
export const ConditionSchema = z.object({
  field: z.string().min(1),
  is: z.enum(['empty', 'non_empty']),
});

// ─────────────────────────────────────────────────────────────── ① trigger
//
// Only the kinds something will actually run. An unimplementable kind in the schema means
// the loader accepts a pipeline that can never fire — a worse failure than rejecting it.
// `http` is absent on purpose: a trigger you must open a port for defeats the reason the
// queue was chosen (D5). `queue` is absent because `pubsub` IS the queue implementation.

export const ManualTriggerSchema = z.object({ kind: z.literal('manual') });

export const ScheduleTriggerSchema = z.object({
  kind: z.literal('schedule'),
  /** Standard 5-field cron. Validated for shape here, for meaning by the adapter. */
  cron: z.string().min(1),
  timezone: z.string().optional(),
});

export const PubSubTriggerSchema = z.object({
  kind: z.literal('pubsub'),
  topic: z.string().min(1),
  subscription: z.string().min(1),
  credential: CredentialRefSchema.optional(),
});

export const TriggerSchema = z.discriminatedUnion('kind', [
  ManualTriggerSchema,
  ScheduleTriggerSchema,
  PubSubTriggerSchema,
]);

// ─────────────────────────────────────────────────────────────── ② input
//
// Fetch-back (D6): the event carries an identifier, and the record is read at processing
// time. A queued event can sit for a while, and the source can change underneath it —
// carrying the data would mean acting on a stale copy.

export const HttpRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** `{{field}}` placeholders are filled from the event/derived fields. */
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  /** Secrets are never written here — this points at the credential store, and the
   *  resolved value is sent as a bearer token. Same rule as the rest of the config. */
  credential: CredentialRefSchema.optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().positive().default(15_000),
});

/** The event body is already the input. */
export const NoneInputSchema = z.object({
  kind: z.literal('none'),
  select: z.record(z.string(), FieldSelectorSchema).default({}),
  require: z.array(z.string()).default([]),
  skip_if: ConditionSchema.optional(),
});

/** One HTTP call covers REST, GraphQL (POST + JSON body) and in-house APIs alike (D7). */
export const HttpInputSchema = z.object({
  kind: z.literal('http'),
  request: HttpRequestSchema,
  /** Response path → flat input field. These names are what the prompt template sees. */
  select: z.record(z.string(), FieldSelectorSchema).default({}),
  /** Missing any of these means skip, not retry — a retry would fetch the same gap. */
  require: z.array(z.string()).default([]),
  /** Guards against re-processing something already handled. */
  skip_if: ConditionSchema.optional(),
});

export const InputSchema = z.discriminatedUnion('kind', [NoneInputSchema, HttpInputSchema]);

// ─────────────────────────────────────────────────────────────── ③ agent
//
// One turn: prompt in, structured answer out, then checked. The checks are not optional
// politeness — the rule may be written in the prompt, but the answer is verified in code
// regardless. A model that ignores an instruction must not be able to write a bad value
// into someone's system.

export const OutputShapeSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).default([]),
  })
  .passthrough();

export const ValidationSchema = z.object({
  /** Values outside the list are dropped and recorded, never sent on. The list itself can
   *  be fetched, so a vocabulary that changes daily doesn't mean editing the pipeline. */
  allowed_values: z
    .object({
      field: z.string().min(1),
      values: z.array(z.string()).optional(),
      source: HttpRequestSchema.optional(),
      /** Where the list sits inside the response, when it isn't the whole body. */
      select: z.string().optional(),
    })
    .refine((v) => !!v.values || !!v.source, {
      message: 'allowed_values needs either an inline `values` list or a `source` to fetch it from',
    })
    .optional(),
  max_items: z.object({ field: z.string().min(1), limit: z.number().int().positive() }).optional(),
  min_confidence: z.object({ field: z.string().min(1), threshold: z.number().min(0).max(1) }).optional(),
});

export const AgentStepSchema = z.object({
  /** Omitted = use the app's configured provider. Operational and development AI share
   *  the same provider settings and the same token ceiling (D24, D12). */
  provider: z.enum(['claude', 'gemini', 'gpt']).optional(),
  model: z.string().optional(),
  max_tokens: z.number().int().positive().default(4096),
  prompt: z.object({
    system: z.string().min(1),
    /** `{{field}}` placeholders are filled from the selected input fields. */
    user_template: z.string().min(1),
  }),
  /** The structured answer's shape. Requested from the model and checked on return. */
  schema: OutputShapeSchema,
  validate: ValidationSchema.default({}),
});

// ─────────────────────────────────────────────────────────────── ④ output
//
// Corral does not know the user's data model, so storing the result is their system's job
// (D8). It either calls their API or publishes a message.

export const NoneOutputSchema = z.object({ kind: z.literal('none') });

export const HttpOutputSchema = z.object({
  kind: z.literal('http'),
  request: HttpRequestSchema,
});

export const PubSubOutputSchema = z.object({
  kind: z.literal('pubsub'),
  topic: z.string().min(1),
  credential: CredentialRefSchema.optional(),
  /** `{{field}}` placeholders are filled from the answer. */
  message: z.record(z.string(), z.unknown()).default({}),
});

export const OutputSchema = z.discriminatedUnion('kind', [NoneOutputSchema, HttpOutputSchema, PubSubOutputSchema]);

// ─────────────────────────────────────────────────────────────── the pipeline

/** What to do when the answer fails `min_confidence`. Defaults to not sending it (D14):
 *  the run is recorded with a link to wherever a human can look, and nothing is written. */
export const LowConfidenceSchema = z.object({
  action: z.enum(['report', 'skip', 'send']).default('report'),
  /** Deep link to the user's own review screen. `{{field}}` placeholders allowed. */
  review_url: z.string().optional(),
});

export const PipelineSchema = z.object({
  /** Stable identifier — used in history, the UI, and manual runs. */
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'key must be lowercase letters, digits and dashes, starting with a letter or digit'),
  enabled: z.boolean().default(true),
  /** Free text for the operator; never read by the runtime. */
  description: z.string().optional(),
  /** Concurrent runs of THIS pipeline. Start at 1 and raise once you've measured — it is
   *  a property of the work, not of how the work arrives, so it sits here and not on the
   *  trigger. */
  max_concurrent: z.number().int().positive().default(1),
  trigger: TriggerSchema,
  input: InputSchema,
  agent: AgentStepSchema,
  output: OutputSchema,
  on_low_confidence: LowConfidenceSchema.default({ action: 'report' }),
});

export type Pipeline = z.infer<typeof PipelineSchema>;
export type PipelineTrigger = z.infer<typeof TriggerSchema>;
export type PipelineInput = z.infer<typeof InputSchema>;
export type PipelineAgentStep = z.infer<typeof AgentStepSchema>;
export type PipelineOutput = z.infer<typeof OutputSchema>;
export type HttpRequestDef = z.infer<typeof HttpRequestSchema>;
export type FieldSelector = z.infer<typeof FieldSelectorSchema>;
export type PipelineValidation = z.infer<typeof ValidationSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
