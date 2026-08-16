/**
 * A second pipeline, to find out how far the declaration actually stretches.
 *
 * The first one — classify one record, write a label back — exercised one corner of every
 * axis: an event per item, a single record fetched, a scalar answer, an HTTP write. One
 * shape working proves nothing about the shape of the schema. So this is deliberately the
 * other corner of all four:
 *
 *   schedule (periodic)  →  http, a *list*  →  a summary over many  →  pubsub (publish)
 *
 * The rule for this file is that the pipeline below is a **declaration only**. If it needs
 * anything corral cannot already do, that is the finding, and it belongs in the design
 * document rather than in a special case here.
 *
 * Both HTTP servers are real, and the model step is the real one-turn runner with a stub
 * provider behind it — so the prompt asserted below is the prompt production code built,
 * not one this test rendered for itself. A list the model cannot read is a turn paid for
 * and thrown away, and nothing but the prompt itself shows that.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient, ChatTurn, NeutralMessage } from '../../agent/api-loop.js';
import { startOpsHost, type OpsHost } from '../ops-host.js';
import { OneTurnOperationRunner } from '../operation/one-turn.js';
import { ScheduleTrigger } from '../trigger/schedule.js';
import { PipelineSchema, type Pipeline } from './schema.js';

let api: Server;
let apiBase: string;
let queue: Server;
let dir: string;
/** What the source API answers with, per test. */
let records: Array<Record<string, unknown>>;
/** Every message that reached the queue, decoded. */
let published: Array<Record<string, unknown>>;
/** The user message the model was actually sent. */
let prompts: string[];
/** What the stub provider answers with. */
let answer: Record<string, unknown>;

const provider: ChatClient = {
  provider: 'claude',
  preflight: async () => ({ ok: true }),
  send: async (messages: NeutralMessage[]): Promise<ChatTurn> => {
    prompts.push(String(messages.at(-1)?.content ?? ''));
    return { text: JSON.stringify(answer), toolCalls: [], inputTokens: 30, outputTokens: 10 };
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'corral-second-'));
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  records = [];
  published = [];
  prompts = [];
  answer = { summary: 'three records, nothing alarming', highlights: ['a', 'b'], confidence: 0.9 };

  api = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { items: records, total: records.length } }));
  });
  queue = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sent = JSON.parse(body) as { messages: Array<{ data: string }> };
      for (const m of sent.messages) published.push(JSON.parse(Buffer.from(m.data, 'base64').toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageIds: ['1'] }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => queue.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  process.env.PUBSUB_EMULATOR_HOST = `127.0.0.1:${(queue.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.PUBSUB_EMULATOR_HOST;
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => queue.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The second pipeline, written the way an operator would write it.
 *
 * `window=1d` rather than a computed start time: a scheduled tick knows when it fired and
 * nothing else, and date arithmetic in a template is not something a declaration can
 * execute. That limit is written up in the design document rather than worked around here.
 */
const DEFINITION = (): string => `
key: daily-digest
description: 하루치 항목을 모아 요약을 만들어 알림 토픽으로 보낸다
trigger:
  kind: schedule
  cron: "0 9 * * *"
input:
  kind: http
  request:
    method: GET
    url: "${apiBase}/api/records?window=1d"
  select:
    records: { path: "data.items", limit: 3 }
    total: "data.total"
  require: [records]
  skip_if: { field: "data.items", is: empty }
agent:
  prompt:
    system: 여러 건을 하나의 요약으로 만든다.
    user_template: |
      전체 {{total}}건 중 {{records}}
  schema:
    type: object
    properties:
      summary: { type: string }
      highlights: { type: array }
      confidence: { type: number }
    required: [summary, confidence]
  validate:
    max_items: { field: highlights, limit: 2 }
    min_confidence: { field: confidence, threshold: 0.6 }
output:
  kind: pubsub
  topic: projects/p/topics/digests
  message:
    summary: "{{summary}}"
    highlights: "{{highlights}}"
    covered: "{{total}}"
    period_end: "{{scheduledAt}}"
on_low_confidence:
  action: report
  review_url: "https://example.test/admin/digests?at={{scheduledAt}}"
`;

async function host(): Promise<OpsHost> {
  writeFileSync(join(dir, 'pipelines', 'digest.yaml'), DEFINITION());
  return startOpsHost({ stateDir: dir, operation: new OneTurnOperationRunner({ clients: [provider] }) });
}

/** The event a scheduled tick hands over. */
const tick = { scheduledAt: '2026-08-16T09:00:00.000Z', pipeline: 'daily-digest' };

describe('the declaration alone', () => {
  it('loads with no code behind it', async () => {
    const h = await host();

    expect(h.error).toBeUndefined();
    expect(h.list()).toEqual([expect.objectContaining({ key: 'daily-digest', trigger: 'schedule', enabled: true })]);
  });

  it('references the field name a tick really carries', async () => {
    // `period_end: "{{scheduledAt}}"` is only meaningful if that is what a tick sends.
    // Renaming it in the trigger would otherwise publish an empty field, silently.
    vi.useFakeTimers();
    try {
      const clock = { at: new Date(2026, 7, 16, 8, 59, 0).getTime() };
      const fired: Array<Record<string, unknown>> = [];
      const stop = new ScheduleTrigger({ now: () => clock.at }).start(hourly(), async (e) => {
        fired.push(e as Record<string, unknown>);
        return undefined;
      });
      clock.at += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      stop();

      expect(fired[0]).toHaveProperty('scheduledAt');
      expect(Object.keys(tick)).toEqual(expect.arrayContaining(Object.keys(fired[0] ?? {})));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('many records in, one summary out', () => {
  beforeEach(() => {
    records = [
      { id: 1, title: 'first', state: 'open' },
      { id: 2, title: 'second', state: 'open' },
      { id: 3, title: 'third', state: 'closed' },
      { id: 4, title: 'fourth', state: 'open' },
    ];
  });

  it('puts the list in front of the model, capped by the selector', async () => {
    const h = await host();

    const { run } = await h.runManually('daily-digest', tick);

    expect(run?.outcome).toBe('completed');
    expect(prompts[0]).toContain('전체 4건 중');
    expect(prompts[0]).toContain('"title":"third"'); // readable, and really there
    expect(prompts[0]).not.toContain('fourth'); // three of four — `limit: 3`
    expect(prompts[0]).not.toContain('[object Object]');
  });

  it('publishes the answer with its types, and the time it covered', async () => {
    const h = await host();

    await h.runManually('daily-digest', tick);

    expect(published[0]).toEqual({
      summary: 'three records, nothing alarming',
      highlights: ['a', 'b'], // a list, not "a,b"
      covered: 4, // a number, not "4"
      // The tick's own field, still there after an input step that selected out of the
      // response — without it a digest cannot say what period it covers.
      period_end: '2026-08-16T09:00:00.000Z',
    });
  });

  it('drops the extra highlights the model was told not to send', async () => {
    answer = { summary: 's', highlights: ['a', 'b', 'c'], confidence: 0.9 };
    const h = await host();

    const { run } = await h.runManually('daily-digest', tick);

    expect(run?.dropped).toEqual(['highlights: c']);
    expect(published[0]?.highlights).toEqual(['a', 'b']);
  });

  it('holds back a doubtful digest and links to the tick it came from', async () => {
    answer = { summary: 's', highlights: [], confidence: 0.2 };
    const h = await host();

    const { run } = await h.runManually('daily-digest', tick);

    expect(run).toMatchObject({
      outcome: 'reported',
      reviewUrl: 'https://example.test/admin/digests?at=2026-08-16T09:00:00.000Z',
    });
    expect(published).toHaveLength(0);
  });
});

describe('a day with nothing in it', () => {
  it('skips before spending a turn', async () => {
    records = [];
    const h = await host();

    const { run } = await h.runManually('daily-digest', tick);

    // A periodic pipeline runs whether or not there is work, so the empty day is the
    // common case and must not cost a turn.
    expect(run).toMatchObject({ outcome: 'skipped', stage: 'input' });
    expect(prompts).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

/** A minimal pipeline on an every-hour schedule, for the trigger-shape check. */
function hourly(): Pipeline {
  return PipelineSchema.parse({
    key: 'daily-digest',
    trigger: { kind: 'schedule', cron: '* * * * *' },
    input: { kind: 'none' },
    agent: { prompt: { system: 's', user_template: 'u' }, schema: { type: 'object', properties: { a: { type: 'string' } } } },
    output: { kind: 'none' },
  });
}
