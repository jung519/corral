/**
 * The model step, end to end: a pipeline file on disk, the real provider client, and a
 * run driven through the ops host. Only the network is stubbed — everything between the
 * YAML and the HTTP body is the real thing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSchema } from '../../config/schema.js';
import { FileCredentialStore } from '../../credentials/file-store.js';
import { OpsHost } from '../ops-host.js';
import { opsChatClients, opsModelFor } from './clients.js';
import { OneTurnOperationRunner } from './one-turn.js';

let dir: string;
let sent: any;

/** Anthropic's streaming shape, carrying one JSON answer as the assistant's text. */
function stubAnthropic(text: string): void {
  const lines = [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 0 } } }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 100 } }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(`${lines.map((l) => `data: ${l}`).join('\n\n')}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
}

const agentConfig = (over: Record<string, unknown> = {}) =>
  AgentSchema.parse({
    provider: 'claude',
    transport: 'api',
    credential: { service: 'anthropic', account: 'default' },
    models: { implementation: 'sonnet', planning: 'opus' },
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-ops-wiring-'));
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(
    join(dir, 'pipelines', 'classify.yaml'),
    `
key: classify
trigger: { kind: manual }
input:
  kind: none
  select: { title: "data.title" }
agent:
  prompt:
    system: "You label records."
    user_template: "Title: {{title}}"
  schema:
    type: object
    properties:
      items: { type: array }
      confidence: { type: number }
    required: [items, confidence]
output: { kind: none }
`,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

async function hostWithProvider(): Promise<OpsHost> {
  const credentials = new FileCredentialStore(join(dir, 'credentials.json'));
  await credentials.set({ service: 'anthropic', account: 'default' }, 'sk-ant-test');
  const agent = agentConfig();
  const clients = await opsChatClients(agent, credentials);
  const host = new OpsHost({ stateDir: dir });
  await host.load();
  host.useOperation(new OneTurnOperationRunner({ clients, modelFor: opsModelFor(agent) }));
  return host;
}

describe('a pipeline reaching a real provider client', () => {
  it('runs the whole way through and records what it cost', async () => {
    stubAnthropic(JSON.stringify({ items: ['news'], confidence: 0.92 }));
    const host = await hostWithProvider();

    const { run } = await host.runManually('classify', { data: { title: 'a record' } });

    expect(run).toMatchObject({
      outcome: 'completed',
      provider: 'claude',
      model: 'sonnet',
      inputTokens: 900,
      outputTokens: 100,
      tokens: 1000,
    });
    expect(run?.costUsd).toBeGreaterThan(0);
    expect((await host.history.list({ days: 1 }))[0]).toMatchObject({ outcome: 'completed', provider: 'claude' });
  });

  it('sends the filled template and the requested shape on the wire', async () => {
    stubAnthropic(JSON.stringify({ items: [], confidence: 1 }));
    const host = await hostWithProvider();

    await host.runManually('classify', { data: { title: 'a record' } });

    expect(sent.system[0].text).toContain('You label records.');
    expect(sent.system[0].text).toContain('single JSON object');
    expect(sent.messages[0].content[0].text).toBe('Title: a record');
    // The provider client resolves the alias itself — proof the real one is in the path.
    expect(sent.model).toBe('claude-sonnet-4-5');
  });

  it('ends as a model failure, with the reason, when the answer is off-schema', async () => {
    stubAnthropic('Sure! Here you go: {"items": []}');
    const host = await hostWithProvider();

    const { run } = await host.runManually('classify', { data: { title: 'x' } });

    expect(run).toMatchObject({ outcome: 'agent_failed', stage: 'agent' });
    expect(run?.reason).toMatch(/claude: the reply was not JSON/);
  });
});

describe('choosing the providers from the shared config', () => {
  it('takes the primary and its fallbacks, in that order', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'anthropic', account: 'default' }, 'k1');
    await credentials.set({ service: 'google', account: 'default' }, 'k2');

    const clients = await opsChatClients(
      agentConfig({
        fallbacks: [
          { provider: 'gemini', transport: 'api', credential: { service: 'google', account: 'default' }, models: {} },
        ],
      }),
      credentials,
    );

    expect(clients.map((c) => c.provider)).toEqual(['claude', 'gemini']);
  });

  it('leaves out a cli-transport entry — there is no one-turn call to make', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));

    const clients = await opsChatClients(
      AgentSchema.parse({ provider: 'claude', transport: 'cli', models: {} }),
      credentials,
    );

    // The CLI transport spawns a coding agent that reads files and runs commands; you
    // cannot ask it one question and get one JSON object back.
    expect(clients).toEqual([]);
  });

  it('drops a provider whose key is missing rather than keeping a client that always fails', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json')); // nothing stored

    expect(await opsChatClients(agentConfig(), credentials)).toEqual([]);
  });

  it('defaults to the everyday model, not the planning one', async () => {
    const modelFor = opsModelFor(agentConfig());

    // A short classification turn doesn't want the model reserved for planning work.
    expect(modelFor('claude')).toBe('sonnet');
  });
});

describe('a core with no api provider', () => {
  it('leaves the model step unwired and says so on the run', async () => {
    const host = new OpsHost({ stateDir: dir });
    await host.load();

    const { run } = await host.runManually('classify', { data: { title: 'x' } });

    expect(run?.reason).toMatch(/not wired up yet/);
  });
});
