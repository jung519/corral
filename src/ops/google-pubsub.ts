/**
 * The Pub/Sub REST surface, shared by the trigger that pulls and the sink that publishes.
 *
 * Four calls, one auth path, one emulator switch. Kept in one place because the trigger
 * and the sink would otherwise each have their own answer to "which host, and with what
 * token" — and the emulator only works if both give the same one.
 *
 * REST rather than the client library: see `trigger/pubsub.ts` for why (gRPC, protobufs
 * and dozens of transitive packages inside the desktop app, for three HTTP calls).
 */
import { fetchJson } from '../core/fetch-retry.js';
import type { CredentialRef, CredentialStore } from '../credentials/types.js';
import { GoogleTokenSource, parseServiceAccountKey } from './trigger/google-auth.js';

export const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const PRODUCTION_BASE = 'https://pubsub.googleapis.com';

export interface ReceivedMessage {
  ackId: string;
  message: { data?: string; attributes?: Record<string, string>; messageId?: string };
}

export interface OutgoingMessage {
  data?: string;
  attributes?: Record<string, string>;
}

/** Resource names are passed per call, so one client serves a subscription and a topic. */
export class PubSubClient {
  constructor(
    private readonly base: string,
    private readonly tokens?: GoogleTokenSource,
  ) {}

  private async post<T>(resource: string, action: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.tokens) headers.authorization = `Bearer ${await this.tokens.token()}`;
    return fetchJson<T>(
      `${this.base}/v1/${resource}:${action}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      { label: 'pubsub', maxRetries: 1 },
    );
  }

  async pull(subscription: string, maxMessages: number): Promise<ReceivedMessage[]> {
    const res = await this.post<{ receivedMessages?: ReceivedMessage[] }>(subscription, 'pull', { maxMessages });
    return res.receivedMessages ?? [];
  }

  async ack(subscription: string, ackIds: string[]): Promise<void> {
    await this.post(subscription, 'acknowledge', { ackIds });
  }

  /** Deadline 0 = "give it to someone else now" — Pub/Sub's negative acknowledgement. */
  async nack(subscription: string, ackIds: string[]): Promise<void> {
    await this.post(subscription, 'modifyAckDeadline', { ackIds, ackDeadlineSeconds: 0 });
  }

  /** Returns the ids Pub/Sub assigned, which is the proof it accepted them. */
  async publish(topic: string, messages: OutgoingMessage[]): Promise<string[]> {
    const res = await this.post<{ messageIds?: string[] }>(topic, 'publish', { messages });
    return res.messageIds ?? [];
  }
}

/**
 * A client for whatever Pub/Sub this core should talk to.
 *
 * `PUBSUB_EMULATOR_HOST` is the emulator's entire contract: that variable set, plain HTTP,
 * no auth. Same code path otherwise — what runs locally is what runs in production.
 */
export async function pubsubClient(
  credential: CredentialRef | undefined,
  credentials: CredentialStore | undefined,
  now?: () => number,
): Promise<PubSubClient> {
  const emulator = process.env.PUBSUB_EMULATOR_HOST;
  if (emulator) {
    return new PubSubClient(emulator.startsWith('http') ? emulator : `http://${emulator}`);
  }

  if (!credential || !credentials) {
    throw new Error('talking to Pub/Sub needs a credential (a service-account JSON key)');
  }
  const raw = await credentials.get(credential);
  if (!raw) throw new Error(`no secret stored for ${credential.service}:${credential.account}`);

  return new PubSubClient(PRODUCTION_BASE, new GoogleTokenSource(parseServiceAccountKey(raw), PUBSUB_SCOPE, now));
}
