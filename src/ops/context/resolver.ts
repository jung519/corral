/**
 * Turning a step's `context` declaration into fields a template can reach.
 *
 * Thin on purpose. Everything that could go wrong — a request, a path that matches
 * nothing, a cache — belongs to the store; what is left here is the loop over the names a
 * pipeline declared, and the decision that a name whose list cannot be had is a failure
 * rather than an empty value.
 *
 * **A missing list is not an empty list.** Handing the prompt `{{allowed}}` rendered as
 * nothing would ask the model to choose from an empty set, and every answer it gave would
 * then be thrown away by the check — a turn paid for to produce nothing. Refusing before
 * the turn costs nothing at all (CRL-65).
 */
import { ContextStore } from './store.js';
import type { ContextResolver, Fields } from '../pipeline/ports.js';
import type { PipelineAgentStep } from '../pipeline/schema.js';

export class StoreContextResolver implements ContextResolver {
  constructor(private readonly store: ContextStore) {}

  async resolve(step: PipelineAgentStep): Promise<Fields> {
    const names = Object.entries(step.context);
    if (!names.length) return {};

    // Fetched together rather than one after another: they are independent, and a pipeline
    // with three lists should not wait out three round trips in series.
    const values = await Promise.all(
      names.map(async ([name, spec]) => {
        try {
          return [name, await this.store.list(spec)] as const;
        } catch (err) {
          // Named, because "a list could not be loaded" is not actionable when a pipeline
          // declares several.
          throw new Error(`context "${name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return Object.fromEntries(values);
  }
}
