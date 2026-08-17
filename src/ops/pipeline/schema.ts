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
 * This is also the contract for everything downstream — the registry, the runtime, the
 * history and the UI all read the shapes defined here.
 */
import { z } from 'zod';
import { CredentialRefSchema } from '../../config/schema.js';
import { isTimeZone, parseCron } from '../trigger/cron.js';

/**
 * Where a value comes from in a JSON response: a dotted path, optionally cut down.
 *
 * Prompt cost is the reason both caps live here rather than in whatever prompt the user
 * happens to write: `truncate` for a long piece of text, `limit` for a long list. A
 * pipeline that reads "everything since yesterday" gets whatever yesterday happened to
 * hold, and the day it holds five hundred records is not the day to find that out.
 */
export const FieldSelectorSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    /** Characters, on a string. */
    truncate: z.number().int().positive().optional(),
    /** Items, on a list. The first `limit`, since a source that orders its results puts
     *  the ones worth reading first. */
    limit: z.number().int().positive().optional(),
  }),
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
  /**
   * Standard 5-field cron, parsed here rather than only by the adapter.
   *
   * It used to be checked for shape here and for meaning at start, which meant an
   * unrunnable expression saved cleanly, loaded cleanly, and left one line in the log —
   * for the same reason the zone below is refused here. CRL-41 opened a box for people to
   * type an expression by hand, so the wrong one has to come back while they are still
   * looking at it.
   */
  cron: z.string().min(1).superRefine((cron, ctx) => {
    try {
      parseCron(cron);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
    }
  }),
  /**
   * Which clock "09:00" is on, as an IANA name (`Asia/Seoul`, `UTC`).
   *
   * Omitted means the machine running the core — fine on a laptop, and the reason a
   * schedule set at home runs at a different hour once the core moves to a VM. Refused
   * here when the runtime does not know the name, because the alternative is a pipeline
   * that loads cleanly and then fires at the wrong time forever.
   */
  timezone: z
    .string()
    .min(1)
    .refine(isTimeZone, (tz) => ({ message: `"${tz}" is not a time zone this machine knows (expected an IANA name like "Asia/Seoul")` }))
    .optional(),
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
  /** Points at the credential store; the resolved value is sent by `auth` below. Corral
   *  does not put secrets in config files, here or anywhere else. */
  credential: CredentialRefSchema.optional(),
  /**
   * How the credential is put on the wire.
   *
   * `Authorization: Bearer <secret>` is the common case and stays the default, but an
   * internal API behind a VPC is as likely to want `X-API-Key: <secret>` — and that is
   * not something a pipeline should have to give up its credential store to express.
   * A `prefix` of `''` sends the secret on its own.
   */
  auth: z
    .object({
      header: z.string().min(1).default('authorization'),
      prefix: z.string().default('Bearer '),
    })
    .default({ header: 'authorization', prefix: 'Bearer ' }),
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
  .passthrough()
  // Only declared properties survive the answer check, so a schema that declares none
  // would pay for a turn and then discard everything it got back — a run that reports
  // success while doing nothing. Caught here rather than at 3am.
  .refine((shape) => Object.keys(shape.properties).length > 0, {
    message: 'schema must declare at least one property — an answer with no declared fields would be discarded',
  });

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

/** What each rule needs the field to be, when the answer schema says what it is. */
const RULE_EXPECTS: Record<string, { type?: string; not?: string; why: string }> = {
  max_items: { type: 'array', why: 'counts the items in a list' },
  min_confidence: { type: 'number', why: 'compares a number against a threshold' },
  allowed_values: { not: 'object', why: 'compares values against a list of allowed ones' },
};

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
})
  /**
   * A rule that cannot do its job is refused here rather than skipped at 3am.
   *
   * Only declared properties survive the answer check, so a rule naming anything else is
   * examining a field that will never be there — `allowed_values` and `max_items` would
   * quietly pass everything, while `min_confidence` would reject everything. Three rules,
   * the same mistake, three different behaviours, none of them the one that was meant.
   */
  .superRefine((step, ctx) => {
    const properties = step.schema.properties;
    for (const [rule, field] of [
      ['allowed_values', step.validate.allowed_values?.field],
      ['max_items', step.validate.max_items?.field],
      ['min_confidence', step.validate.min_confidence?.field],
    ] as const) {
      if (!field) continue;
      const path = ['validate', rule, 'field'];
      if (!(field in properties)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `"${field}" is not declared in the answer schema, so this rule would never see a value`,
        });
        continue;
      }

      // The declared type is optional in JSON Schema and in the answers people write, so
      // a missing one is not a problem — it just means this cannot be settled until a
      // value turns up, and the validator refuses it then.
      const declared = (properties[field] as { type?: unknown } | null)?.type;
      if (typeof declared !== 'string') continue;
      const expects = RULE_EXPECTS[rule];
      if (!expects) continue;
      if (expects.type && declared !== expects.type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${rule} ${expects.why}, but "${field}" is declared ${declared}`,
        });
      }
      if (expects.not && declared === expects.not) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${rule} ${expects.why}, but "${field}" is declared ${declared}`,
        });
      }
    }
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
