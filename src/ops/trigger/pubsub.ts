/**
 * Work arriving from a Pub/Sub subscription — the first trigger meant for real traffic.
 *
 * **No port is opened.** The core pulls; nothing has to reach it. That is the whole reason
 * a queue was chosen (D5): a VM behind a tunnel can do this, and a push endpoint cannot.
 *
 * **Over REST, not the client library.** Synchronous pull is three HTTP calls — pull,
 * acknowledge, modifyAckDeadline — and the alternative is gRPC, protobufs and dozens of
 * transitive packages shipped inside the desktop app. Authentication is one signed JWT
 * (google-auth.ts). Streaming pull would need gRPC; polling is what a queue-shaped
 * workload wants anyway.
 *
 * ## What happens to a message
 *
 * This is the part that matters, because getting it wrong produces either lost work or a
 * subscription that redelivers the same poison message forever.
 *
 *   acknowledged (gone)   the run reached a conclusion — finished, skipped, held back,
 *                         rejected; the message body was unreadable; there is no such
 *                         pipeline; the day's tokens are spent
 *   left unacknowledged   the pipeline was at capacity, or a step failed in a way that
 *                         could plausibly work next time
 *
 * The rule behind it: **acknowledge whatever a retry would repeat.** A malformed message
 * parses the same way tomorrow, a missing pipeline is still missing, and a spent budget
 * is spent until midnight — holding those would be an infinite redelivery loop wearing a
 * disguise.
 *
 * Nothing counts attempts here. A message that keeps failing is what a dead-letter policy
 * is for, and that policy belongs on the subscription where an operator can see and change
 * it — not buried in a counter inside this process (D-note on CRL-18).
 */
import { fetchJson } from '../../core/fetch-retry.js';
import { logger } from '../../core/logger.js';
import type { CredentialRef, CredentialStore } from '../../credentials/types.js';
import type { RunOutcome, RunRecord } from '../pipeline/run.js';
import type { Pipeline } from '../pipeline/schema.js';
import { GoogleTokenSource, parseServiceAccountKey } from './google-auth.js';
import type { FireFn, StopFn, TriggerAdapter, TriggerContext } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/pubsub';
/** How long a pull waits for a message before returning empty. */
const PULL_INTERVAL_MS = 2_000;

/** Outcomes a retry would only repeat. Everything else keeps the message. */
const SETTLED: readonly RunOutcome[] = ['completed', 'skipped', 'reported', 'rejected', 'over_budget'];

interface ReceivedMessage {
  ackId: string;
  message: { data?: string; attributes?: Record<string, string>; messageId?: string };
}

export interface PubSubContext extends TriggerContext {
  credentials?: CredentialStore;
}

export class PubSubTrigger implements TriggerAdapter {
  readonly kind = 'pubsub' as const;

  constructor(private readonly ctx: PubSubContext = {}) {}

  start(pipeline: Pipeline, fire: FireFn): StopFn {
    if (pipeline.trigger.kind !== 'pubsub') throw new Error('PubSubTrigger given a non-pubsub trigger');
    const { subscription, credential } = pipeline.trigger;

    let stopped = false;
    let inFlight: Promise<void> = Promise.resolve();

    const loop = async (): Promise<void> => {
      let client: PubSubClient;
      try {
        client = await this.client(subscription, credential);
      } catch (err) {
        logger.error(`ops: pipeline "${pipeline.key}" cannot reach Pub/Sub — ${message(err)}`);
        return;
      }

      logger.info(`ops: pipeline "${pipeline.key}" subscribed to ${subscription}`);
      while (!stopped) {
        let received: ReceivedMessage[];
        try {
          // Never more than the pipeline will run at once: pulling a hundred messages a
          // slot-limited pipeline cannot start just holds them until they time out.
          received = await client.pull(pipeline.max_concurrent);
        } catch (err) {
          logger.warn(`ops: pull failed for "${pipeline.key}" — ${message(err)}`);
          await sleep(PULL_INTERVAL_MS);
          continue;
        }
        if (!received.length) {
          await sleep(PULL_INTERVAL_MS);
          continue;
        }

        // Tracked so shutdown can wait: a message half-processed and never settled would
        // sit until its deadline lapses, which looks like a stall to whoever published it.
        inFlight = Promise.all(received.map((m) => this.handle(pipeline, m, client, fire))).then(() => {});
        await inFlight;
      }
    };

    void loop();

    return async () => {
      stopped = true;
      await inFlight; // let whatever is mid-flight settle its own message
      logger.info(`ops: pipeline "${pipeline.key}" unsubscribed from ${subscription}`);
    };
  }

  /** Run one message and settle it according to how the run ended. */
  private async handle(pipeline: Pipeline, received: ReceivedMessage, client: PubSubClient, fire: FireFn): Promise<void> {
    const event = decode(received.message);
    if (event === undefined) {
      // Unreadable now and unreadable on every redelivery. Dropping it is the only way
      // out of a loop that would otherwise never end.
      logger.warn(`ops: dropping an unreadable message on "${pipeline.key}" (${received.message.messageId ?? '?'})`);
      await client.ack([received.ackId]).catch(() => {});
      return;
    }

    let record: RunRecord | undefined;
    let threw = false;
    try {
      record = await fire(event);
    } catch (err) {
      // A run that threw did not reach a conclusion — a bug, a full disk, something that
      // may not be true a minute from now. Treating it like a finished run would discard
      // the message over a fault that had nothing to do with its contents.
      threw = true;
      logger.warn(`ops: run failed for "${pipeline.key}" — ${message(err)}`);
    }

    // No record and no error means the pipeline is gone; a retry finds it just as gone.
    const settled = !threw && (!record || SETTLED.includes(record.outcome));
    await (settled ? client.ack([received.ackId]) : client.nack([received.ackId])).catch((err: unknown) =>
      logger.warn(`ops: could not settle a message on "${pipeline.key}" — ${message(err)}`),
    );
  }

  private async client(subscription: string, credential?: CredentialRef): Promise<PubSubClient> {
    // The emulator's whole contract: this variable set, plain HTTP, no auth. Same code
    // path otherwise, so what runs locally is what runs in production.
    const emulator = process.env.PUBSUB_EMULATOR_HOST;
    if (emulator) {
      const base = emulator.startsWith('http') ? emulator : `http://${emulator}`;
      return new PubSubClient(base, subscription, undefined);
    }

    if (!credential || !this.ctx.credentials) {
      throw new Error('a pubsub trigger needs a credential (a service-account JSON key)');
    }
    const raw = await this.ctx.credentials.get(credential);
    if (!raw) throw new Error(`no secret stored for ${credential.service}:${credential.account}`);

    const source = new GoogleTokenSource(parseServiceAccountKey(raw), SCOPE, this.ctx.now);
    return new PubSubClient('https://pubsub.googleapis.com', subscription, source);
  }
}

/** The three REST calls a pull subscription needs. */
export class PubSubClient {
  constructor(
    private readonly base: string,
    /** Full resource name: `projects/<project>/subscriptions/<name>`. */
    private readonly subscription: string,
    private readonly tokens?: GoogleTokenSource,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.tokens) headers.authorization = `Bearer ${await this.tokens.token()}`;
    return headers;
  }

  private async post<T>(action: string, body: unknown): Promise<T> {
    return fetchJson<T>(
      `${this.base}/v1/${this.subscription}:${action}`,
      { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) },
      { label: 'pubsub', maxRetries: 1 },
    );
  }

  async pull(maxMessages: number): Promise<ReceivedMessage[]> {
    const res = await this.post<{ receivedMessages?: ReceivedMessage[] }>('pull', { maxMessages });
    return res.receivedMessages ?? [];
  }

  async ack(ackIds: string[]): Promise<void> {
    await this.post('acknowledge', { ackIds });
  }

  /** Deadline 0 = "give it to someone else now" — Pub/Sub's negative acknowledgement. */
  async nack(ackIds: string[]): Promise<void> {
    await this.post('modifyAckDeadline', { ackIds, ackDeadlineSeconds: 0 });
  }
}

/** Message body → event. `undefined` means it cannot be read at all. */
function decode(message: ReceivedMessage['message']): unknown {
  if (!message.data) {
    // No body, but attributes are a legitimate way to carry an identifier.
    return message.attributes ? { ...message.attributes } : undefined;
  }
  const text = Buffer.from(message.data, 'base64').toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    // Attributes ride alongside, so a publisher can use either and a definition's
    // `select` paths reach both.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ...message.attributes, ...(parsed as Record<string, unknown>) }
      : parsed;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
