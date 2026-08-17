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
 *   never taken out      the day's shared ceiling is spent — the loop stops pulling
 *   acknowledged (gone)  the run reached a conclusion — finished, skipped, held back,
 *                        rejected; the message body was unreadable; there is no such
 *                        pipeline
 *   left unacknowledged  the pipeline was at capacity, a step failed in a way that could
 *                        plausibly work next time, or the trigger was stopped between
 *                        taking the message and running it
 *
 * The rule behind it: **acknowledge whatever a retry would repeat.** A malformed message
 * parses the same way tomorrow and a missing pipeline is still missing — holding those
 * would be an infinite redelivery loop wearing a disguise.
 *
 * A spent ceiling is not one of those, and used to be treated as one. It is spent until
 * midnight, so holding the message would indeed redeliver into it all day — but
 * acknowledging threw the work away, and unlike a malformed message this one would run
 * perfectly well tomorrow. The answer is neither: don't take it out of the subscription
 * (CRL-49). `over_budget` stays in `SETTLED` for the one race left — a batch already in
 * flight when other runs exhaust the ceiling.
 *
 * Nothing counts attempts here. A message that keeps failing is what a dead-letter policy
 * is for, and that policy belongs on the subscription where an operator can see and change
 * it — not buried in a counter inside this process (D-note on CRL-18).
 */
import { logger } from '../../core/logger.js';
import type { CredentialStore } from '../../credentials/types.js';
import { pubsubClient, type PubSubClient, type ReceivedMessage } from '../google-pubsub.js';
import type { RunOutcome, RunRecord } from '../pipeline/run.js';
import type { Pipeline } from '../pipeline/schema.js';
import type { FireFn, StopFn, TriggerAdapter, TriggerContext } from './types.js';

/** How long a pull waits for a message before returning empty. */
const PULL_INTERVAL_MS = 2_000;

/**
 * Outcomes a retry would only repeat. Everything else keeps the message.
 *
 * `over_budget` is the odd one and only reachable now by a race: the loop checks the
 * ceiling before pulling, so a run can only hit it if other runs exhausted the ceiling
 * while this batch was in the air. Holding those would redeliver into a ceiling that is
 * spent until midnight; letting them go loses at most one batch rather than a day's work.
 */
const SETTLED: readonly RunOutcome[] = ['completed', 'skipped', 'reported', 'rejected', 'over_budget'];

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
    /** Set while the loop is waiting; calling it cuts the wait short. */
    let wake: (() => void) | undefined;

    /**
     * Wait, unless someone wakes us.
     *
     * A plain `sleep` was fine while every wait was two seconds. Waiting out a spent
     * ceiling is a wait of hours, and a shutdown that had to sit through it would look
     * wedged — so the stop handle can cut any wait short.
     */
    const rest = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        // Unreferenced, as the plain sleep was: a loop between polls must not be the reason
        // a process that is otherwise finished stays alive.
        timer.unref?.();
        wake = done;
        function done(): void {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
      });

    const loop = async (): Promise<void> => {
      let client: PubSubClient;
      try {
        client = await pubsubClient(credential, this.ctx.credentials, this.ctx.now);
      } catch (err) {
        logger.error(`ops: pipeline "${pipeline.key}" cannot reach Pub/Sub — ${message(err)}`);
        return;
      }

      logger.info(`ops: pipeline "${pipeline.key}" subscribed to ${subscription}`);
      let waitingOnBudget = false;
      while (!stopped) {
        // ── is there anything left to spend? ────────────────────────────────────
        //
        // Asked before pulling, not after. A message this loop takes out of the
        // subscription and cannot run is a message it has to settle somehow, and every
        // way of settling it is worse than not having taken it: acknowledging loses the
        // work, and holding it invites redelivery into the same spent ceiling all day
        // (CRL-49). Left in the subscription it simply waits, which is what a queue is.
        const allowed = this.ctx.budget?.check();
        if (allowed && !allowed.ok) {
          if (!waitingOnBudget) {
            waitingOnBudget = true;
            logger.info(`ops: pipeline "${pipeline.key}" is leaving work in the queue — ${allowed.reason}`);
          }
          // Looked at again on the same interval as an idle pull, and deliberately not a
          // slower one: this check is local where a pull is a network call, so pausing is
          // already cheaper than running. A separate, longer interval would only have made
          // the resume late.
          await rest(PULL_INTERVAL_MS);
          continue;
        }
        if (waitingOnBudget) {
          waitingOnBudget = false;
          logger.info(`ops: pipeline "${pipeline.key}" is pulling again`);
        }

        let received: ReceivedMessage[];
        try {
          // Never more than the pipeline will run at once: pulling a hundred messages a
          // slot-limited pipeline cannot start just holds them until they time out.
          received = await client.pull(subscription, pipeline.max_concurrent);
        } catch (err) {
          logger.warn(`ops: pull failed for "${pipeline.key}" — ${message(err)}`);
          await rest(PULL_INTERVAL_MS);
          continue;
        }

        // ── did we stop while that pull was out? ────────────────────────────────
        //
        // A pull is a long poll, so seconds pass in that call and a stop can land in the
        // middle of it. Without this the loop went straight on to start a run the operator
        // had already stopped — measured at 265ms after `stop()` had returned, on a core
        // about to call `process.exit` (CRL-50).
        //
        // The messages are handed back rather than dropped: held and unsettled, they sit
        // until their deadline lapses.
        if (stopped) {
          if (received.length) {
            await client
              .nack(subscription, received.map((m) => m.ackId))
              .catch((err: unknown) => logger.warn(`ops: could not return messages on "${pipeline.key}" — ${message(err)}`));
          }
          return;
        }
        if (!received.length) {
          await rest(PULL_INTERVAL_MS);
          continue;
        }

        // Awaited here, which is what lets the stop handle wait for the loop itself: a
        // message half-processed and never settled would sit until its deadline lapses,
        // and that looks like a stall to whoever published it.
        await Promise.all(received.map((m) => this.handle(pipeline, subscription, m, client, fire)));
      }
    };

    // The loop's own promise, not the current batch's. Waiting on the batch meant waiting
    // on whichever promise happened to be in the variable — usually an already-resolved
    // one from the batch before, which is why `stop()` used to return in a millisecond
    // with the loop still going (CRL-50).
    const running = loop().catch((err: unknown) => {
      logger.error(`ops: the queue loop for "${pipeline.key}" ended badly — ${message(err)}`);
    });

    return async () => {
      stopped = true;
      wake?.(); // don't sit out a wait we have already decided to abandon
      await running;
      logger.info(`ops: pipeline "${pipeline.key}" unsubscribed from ${subscription}`);
    };
  }

  /** Run one message and settle it according to how the run ended. */
  private async handle(
    pipeline: Pipeline,
    subscription: string,
    received: ReceivedMessage,
    client: PubSubClient,
    fire: FireFn,
  ): Promise<void> {
    const event = decode(received.message);
    if (event === undefined) {
      // Unreadable now and unreadable on every redelivery. Dropping it is the only way
      // out of a loop that would otherwise never end.
      logger.warn(`ops: dropping an unreadable message on "${pipeline.key}" (${received.message.messageId ?? '?'})`);
      await client.ack(subscription, [received.ackId]).catch(() => {});
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
    await (settled ? client.ack(subscription, [received.ackId]) : client.nack(subscription, [received.ackId])).catch((err: unknown) =>
      logger.warn(`ops: could not settle a message on "${pipeline.key}" — ${message(err)}`),
    );
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
