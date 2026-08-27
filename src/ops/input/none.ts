/**
 * The event body IS the input — no fetching.
 *
 * Fetch-back (D6) is the right default for a queue, where an event can sit long enough
 * for its source to change. But a manual run hands the body over directly, and some
 * events genuinely carry everything already; this resolver is that case.
 *
 * The HTTP resolver is the other half and lands with its own issue. Both do only one
 * thing — produce `{raw, fields}` — because `require` and `skip_if` are the lifecycle's
 * to enforce, not each adapter's to remember.
 */
import type { InputResolver, ResolvedInput } from '../pipeline/ports.js';
import { readPath } from '../pipeline/run.js';
import type { FieldSelector, PipelineInput } from '../pipeline/schema.js';

/** Pull a value out of a document, honouring the selector's caps. */
export function selectField(source: unknown, selector: FieldSelector): unknown {
  const path = typeof selector === 'string' ? selector : selector.path;
  const value = readPath(source, path);
  if (typeof selector === 'string') return value;
  // A long piece of text and a long list are the two ways a prompt gets expensive, so both
  // caps live in the definition rather than in whatever the prompt author remembered to
  // write.
  const { truncate, limit } = selector;
  if (truncate && typeof value === 'string' && value.length > truncate) return value.slice(0, truncate);
  if (limit && Array.isArray(value) && value.length > limit) return value.slice(0, limit);
  return value;
}

/** Apply a `select` map to a document. */
export function applySelect(source: unknown, select: Record<string, FieldSelector>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, selector] of Object.entries(select)) fields[name] = selectField(source, selector);
  return fields;
}

export class NoneInputResolver implements InputResolver {
  readonly kind = 'none' as const;

  async resolve(input: PipelineInput, event: unknown): Promise<ResolvedInput> {
    // With no `select`, the body's own top-level keys are the fields — the shortest path
    // from "here is some JSON" to a working pipeline.
    const select = input.select ?? {};
    const fields = Object.keys(select).length
      ? applySelect(event, select)
      : ((event ?? {}) as Record<string, unknown>);
    return { raw: event, fields };
  }
}
