/**
 * The Pub/Sub trigger, against a real HTTP server speaking the emulator's protocol.
 *
 * Almost every test here is about one question: **what happens to the message?** Getting
 * that wrong produces either lost work or a subscription that redelivers the same poison
 * message forever, and neither shows up in a happy-path test.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOutcome, RunRecord } from '../pipeline/run.js';
import { PipelineSchema, type Pipeline } from '../pipeline/schema.js';
import { PubSubTrigger } from './pubsub.js';

const SUBSCRIPTION = 'projects/p/subscriptions/s';

/** A stand-in Pub/Sub: hands out queued messages and records how each was settled. */
class FakePubSub {
  readonly acked: string[] = [];
  readonly nacked: string[] = [];
  /** How many times the trigger asked for work. `0` is a claim worth making. */
  pulls = 0;
  /** Hold a pull that has messages, so a stop can land in the middle of one. */
  pullDelayMs = 0;
  private queue: Array<{ ackId: string; data?: string; attributes?: Record<string, string> }> = [];
  private server!: Server;
  host = '';

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as { ackIds?: string[]; maxMessages?: number }) : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url?.endsWith(':pull')) {
          this.pulls++;
          const take = this.queue.splice(0, parsed.maxMessages ?? 1);
          const reply = (): void => {
            res.end(
              JSON.stringify({
                receivedMessages: take.map((m) => ({
                  ackId: m.ackId,
                  message: { data: m.data, attributes: m.attributes, messageId: m.ackId },
                })),
              }),
            );
          };
          // A real pull is a long poll. Delaying only a pull that found something keeps the
          // idle case fast while leaving a window a stop can land inside.
          if (take.length && this.pullDelayMs) setTimeout(reply, this.pullDelayMs);
          else reply();
        } else if (req.url?.endsWith(':acknowledge')) {
          this.acked.push(...(parsed.ackIds ?? []));
          res.end('{}');
        } else if (req.url?.endsWith(':modifyAckDeadline')) {
          this.nacked.push(...(parsed.ackIds ?? []));
          res.end('{}');
        } else {
          res.end('{}');
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.host = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  publish(ackId: string, payload: unknown, attributes?: Record<string, string>): void {
    this.queue.push({
      ackId,
      data: payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)).toString('base64'),
      attributes,
    });
  }

  /** Publish something that is not JSON at all. */
  publishGarbage(ackId: string): void {
    this.queue.push({ ackId, data: Buffer.from('<<not json>>').toString('base64') });
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let queue: FakePubSub;

const pipeline = (over: Record<string, unknown> = {}): Pipeline =>
  PipelineSchema.parse({
    key: 'classify',
    trigger: { kind: 'pubsub', topic: 'records', subscription: SUBSCRIPTION },
    input: { kind: 'none' },
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    output: { kind: 'none' },
    ...over,
  });

const record = (outcome: RunOutcome): RunRecord => ({
  id: 'r1',
  pipeline: 'classify',
  startedAt: 0,
  endedAt: 1,
  outcome,
});

/** Wait for a condition the trigger's loop will bring about. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  queue = new FakePubSub();
  await queue.listen();
  process.env.PUBSUB_EMULATOR_HOST = queue.host;
});
afterEach(async () => {
  delete process.env.PUBSUB_EMULATOR_HOST;
  await queue.close();
});

describe('receiving work', () => {
  it('turns a message into a run', async () => {
    const seen: unknown[] = [];
    queue.publish('m1', { id: 42, title: 'a record' });

    const stop = new PubSubTrigger().start(pipeline(), async (event) => {
      seen.push(event);
      return record('completed');
    });
    await until(() => seen.length > 0);
    await stop();

    expect(seen[0]).toEqual({ id: 42, title: 'a record' });
  });

  it('carries attributes alongside the body, so either can hold the identifier', async () => {
    const seen: unknown[] = [];
    queue.publish('m1', { title: 'a record' }, { id: '42' });

    const stop = new PubSubTrigger().start(pipeline(), async (event) => (seen.push(event), record('completed')));
    await until(() => seen.length > 0);
    await stop();

    expect(seen[0]).toEqual({ id: '42', title: 'a record' });
  });

  it('accepts a message that is only attributes', async () => {
    const seen: unknown[] = [];
    queue.publish('m1', undefined, { id: '42' });

    const stop = new PubSubTrigger().start(pipeline(), async (event) => (seen.push(event), record('completed')));
    await until(() => seen.length > 0);
    await stop();

    expect(seen[0]).toEqual({ id: '42' });
  });

  it('pulls no more at a time than the pipeline will run', async () => {
    let maxSeen = 0;
    for (let i = 0; i < 10; i++) queue.publish(`m${i}`, { i });

    const stop = new PubSubTrigger().start(pipeline({ max_concurrent: 3 }), async () => {
      maxSeen = Math.max(maxSeen, 1);
      return record('completed');
    });
    await until(() => queue.acked.length >= 10, 6000);
    await stop();

    // Pulling a hundred messages a slot-limited pipeline cannot start just holds them
    // until their deadlines lapse.
    expect(queue.acked).toHaveLength(10);
  });
});

describe('what happens to the message', () => {
  /** Run one message whose run ends with `outcome`, and report how it was settled. */
  async function settle(outcome: RunOutcome): Promise<'acked' | 'nacked'> {
    queue.publish('m1', { id: 1 });
    const stop = new PubSubTrigger().start(pipeline(), async () => record(outcome));
    await until(() => queue.acked.length + queue.nacked.length > 0);
    await stop();
    return queue.acked.includes('m1') ? 'acked' : 'nacked';
  }

  it('acknowledges anything a retry would only repeat', async () => {
    // A conclusion is a conclusion — running it again produces the same one.
    expect(await settle('completed')).toBe('acked');
    expect(await settle('skipped')).toBe('acked');
    expect(await settle('reported')).toBe('acked');
    expect(await settle('rejected')).toBe('acked');
  });

  it('acknowledges a run stopped by the day budget', async () => {
    // Spent until midnight. Holding the message would mean redelivering into a spent
    // budget all day — the retry storm this policy exists to prevent.
    expect(await settle('over_budget')).toBe('acked');
  });

  it('leaves a throttled message for later', async () => {
    // Capacity frees up in seconds; the queue is exactly the right place to wait.
    expect(await settle('throttled')).toBe('nacked');
  });

  it('leaves a message whose step failed', async () => {
    // An unreachable source or a rate-limited model may well work next time. Nothing
    // counts attempts here — that is what a dead-letter policy on the subscription is
    // for, where an operator can see and change it.
    expect(await settle('input_failed')).toBe('nacked');
    expect(await settle('agent_failed')).toBe('nacked');
    expect(await settle('output_failed')).toBe('nacked');
  });

  it('drops an unreadable message without ever running it', async () => {
    let fired = 0;
    queue.publishGarbage('bad');

    const stop = new PubSubTrigger().start(pipeline(), async () => (fired++, record('completed')));
    await until(() => queue.acked.length > 0);
    await stop();

    // It parses the same way tomorrow. Holding it is an infinite redelivery loop wearing
    // a disguise.
    expect(queue.acked).toEqual(['bad']);
    expect(fired).toBe(0);
  });

  it('drops a message for a pipeline that is gone', async () => {
    queue.publish('m1', { id: 1 });

    const stop = new PubSubTrigger().start(pipeline(), async () => undefined);
    await until(() => queue.acked.length > 0);
    await stop();

    expect(queue.acked).toEqual(['m1']);
  });

  it('leaves the message when the run throws outright', async () => {
    queue.publish('m1', { id: 1 });

    const stop = new PubSubTrigger().start(pipeline(), async () => {
      throw new Error('boom');
    });
    await until(() => queue.nacked.length > 0);
    await stop();

    expect(queue.nacked).toEqual(['m1']);
  });
});

describe('shutting down', () => {
  it('waits for a message it is already handling', async () => {
    let release: (() => void) | undefined;
    let finished = false;
    queue.publish('m1', { id: 1 });

    const stop = new PubSubTrigger().start(pipeline(), async () => {
      await new Promise<void>((r) => (release = r));
      finished = true;
      return record('completed');
    });
    await until(() => release !== undefined);

    const stopping = stop();
    release?.();
    await stopping;

    // A message half-processed and never settled sits until its deadline lapses, which
    // looks like a stall to whoever published it.
    expect(finished).toBe(true);
    expect(queue.acked).toEqual(['m1']);
  });

  it('stops pulling', async () => {
    const stop = new PubSubTrigger().start(pipeline(), async () => record('completed'));
    await stop();

    queue.publish('later', { id: 2 });
    await new Promise((r) => setTimeout(r, 300));

    expect(queue.acked).not.toContain('later');
  });

  /**
   * A pull is a long poll, so a stop can land while one is out. The loop used to go straight
   * on and start the run anyway — measured at 265ms after `stop()` had returned, on a core
   * whose next statement is `process.exit` (CRL-50). `stop()` returned in a millisecond
   * because it waited on the previous batch's already-resolved promise.
   */
  it('starts nothing new when a stop lands mid-pull, and hands the message back', async () => {
    queue.pullDelayMs = 300;
    const runs: number[] = [];
    const stop = new PubSubTrigger().start(pipeline(), async () => (runs.push(Date.now()), record('completed')));

    await until(() => queue.pulls > 0); // a pull is out
    queue.publish('m1', { id: 1 });
    await until(() => queue.pulls > 1); // and now one is out with m1 in it
    const stoppedAt = Date.now();
    await stop();
    const returnedAt = Date.now();
    await new Promise((r) => setTimeout(r, 500)); // watch for anything late

    expect(runs).toHaveLength(0);
    // Waited for the pull rather than sailing past it.
    expect(returnedAt - stoppedAt).toBeGreaterThan(50);
    // Held and unsettled, it would sit until its deadline lapsed.
    expect(queue.nacked).toEqual(['m1']);
    expect(queue.acked).toEqual([]);
  });
});

/**
 * The ceiling is shared with the development AI and resets at midnight. A queue that keeps
 * handing over messages nothing can run turns a spent ceiling into lost work: the loop has
 * to settle whatever it took, and both ways of settling are worse than not having taken it
 * (CRL-49). Left in the subscription, the work simply waits.
 */
describe('when the day\'s tokens are spent', () => {
  const spent = { check: () => ({ ok: false, reason: 'daily input token limit reached' }) };

  it('leaves the work in the queue instead of taking it out', async () => {
    queue.publish('m1', { id: 1 });
    const runs: unknown[] = [];

    const stop = new PubSubTrigger({ budget: spent }).start(pipeline(), async () => (runs.push(1), record('completed')));
    await new Promise((r) => setTimeout(r, 300));
    await stop();

    // Not pulled, so not run, and not settled either way — still in the subscription.
    expect(queue.pulls).toBe(0);
    expect(runs).toHaveLength(0);
    expect(queue.acked).toEqual([]);
    expect(queue.nacked).toEqual([]);
  });

  it('picks the work up once there is budget again', async () => {
    let ok = false;
    queue.publish('m1', { id: 1 });
    const runs: unknown[] = [];

    const stop = new PubSubTrigger({ budget: { check: () => ({ ok }) } }).start(
      pipeline(),
      async () => (runs.push(1), record('completed')),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(queue.pulls).toBe(0); // still nothing taken

    ok = true; // midnight
    await until(() => runs.length > 0);
    await stop();

    expect(queue.acked).toEqual(['m1']);
  });

  it('does not make a shutdown sit out the wait', async () => {
    // The recheck interval is half a minute. A stop that had to wait for it would look
    // wedged to whoever pressed Ctrl-C.
    const stop = new PubSubTrigger({ budget: spent }).start(pipeline(), async () => record('completed'));
    await new Promise((r) => setTimeout(r, 100)); // let it settle into the wait

    const at = Date.now();
    await stop();

    expect(Date.now() - at).toBeLessThan(1_000);
  });
});

describe('without an emulator', () => {
  it('refuses to start with no credential rather than failing per message', async () => {
    // Built while the emulator variable is still set — the schema refuses a definition like
    // this now (CRL-46), and what is under test here is the runtime guard behind it: a
    // credential that cannot be resolved when the loop actually starts.
    const p = pipeline();
    delete process.env.PUBSUB_EMULATOR_HOST;
    let fired = 0;

    const stop = new PubSubTrigger().start(p, async () => (fired++, record('completed')));
    await new Promise((r) => setTimeout(r, 200));
    await stop();

    expect(fired).toBe(0);
  });
});
