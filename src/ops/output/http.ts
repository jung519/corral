/**
 * Handing the result back to the user's own API.
 *
 * Corral does not know the user's data model and does not touch their store (D8). It
 * knows what the answer was and where they said to send it; deciding what that means is
 * their system's job. That is what keeps the operational AI domain-neutral — the moment
 * it wrote to a database it would have to understand one.
 *
 * The request block is the same one the input resolver uses, so a `PATCH` back to the
 * record you just read is the definition you would guess.
 */
import type { CredentialStore } from '../../credentials/types.js';
import { runHttpRequest } from '../http.js';
import type { Fields, OutputSink } from '../pipeline/ports.js';
import type { PipelineOutput } from '../pipeline/schema.js';

export class HttpOutputSink implements OutputSink {
  readonly kind = 'http' as const;

  constructor(private readonly credentials?: CredentialStore) {}

  async send(output: PipelineOutput, fields: Fields): Promise<void> {
    if (output.kind !== 'http') throw new Error('HttpOutputSink given a non-http output');
    // `fields` is the input's selected values merged with the answer, so a body template
    // can reference the identifier it came in with as well as what the model produced.
    await runHttpRequest(output.request, fields, this.credentials);
  }
}
