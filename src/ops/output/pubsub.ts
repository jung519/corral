/**
 * Publishing the result as a message.
 *
 * The other half of D8: some systems would rather be told than called. Publishing also
 * decouples the pipeline from whatever consumes the result — a slow consumer stops being
 * the pipeline's problem, which matters when the pipeline has a concurrency limit and a
 * queue of its own waiting behind it.
 *
 * Same REST client the trigger pulls with (`google-pubsub.ts`), so the emulator switch
 * and the auth path are the same on both sides.
 */
import type { CredentialStore } from '../../credentials/types.js';
import { pubsubClient } from '../google-pubsub.js';
import { fillDeep } from '../http.js';
import type { Fields, OutputSink } from '../pipeline/ports.js';
import type { PipelineOutput } from '../pipeline/schema.js';

export class PubSubOutputSink implements OutputSink {
  readonly kind = 'pubsub' as const;

  constructor(
    private readonly credentials?: CredentialStore,
    private readonly now?: () => number,
  ) {}

  async send(output: PipelineOutput, fields: Fields): Promise<void> {
    if (output.kind !== 'pubsub') throw new Error('PubSubOutputSink given a non-pubsub output');

    // With no `message` template the whole result is the message — the shortest useful
    // thing to publish, and what a consumer of a classification pipeline usually wants.
    const body = Object.keys(output.message).length ? fillDeep(output.message, fields) : fields;

    const client = await pubsubClient(output.credential, this.credentials, this.now);
    await client.publish(output.topic, [{ data: Buffer.from(JSON.stringify(body)).toString('base64') }]);
  }
}
