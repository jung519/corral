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
import { opsChatClients, opsCliTransports, opsModelFor, opsUsableAgents } from './clients.js';
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

    // The opener is unwrapped, so the complaint is about the answer itself rather than
    // its packaging — which is the whole point of recovering it first.
    expect(run).toMatchObject({ outcome: 'agent_failed', stage: 'agent' });
    expect(run?.reason).toMatch(/claude: missing required field\(s\): confidence/);
  });

  it('accepts a fenced answer end to end', async () => {
    stubAnthropic('```json\n{"items":["news"],"confidence":0.7}\n```');
    const host = await hostWithProvider();

    const { run } = await host.runManually('classify', { data: { title: 'x' } });

    // Providers do this even when told not to. Failing here would discard a good answer
    // that had already been paid for.
    expect(run).toMatchObject({ outcome: 'completed' });
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

  it('keeps two accounts of the same provider — that is the quota case, not a duplicate', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'anthropic', account: 'default' }, 'k1');
    await credentials.set({ service: 'anthropic', account: 'second' }, 'k2');

    const clients = await opsChatClients(
      agentConfig({
        fallbacks: [
          { provider: 'claude', transport: 'api', credential: { service: 'anthropic', account: 'second' }, models: {} },
        ],
      }),
      credentials,
    );

    // The development side supports this too (bootstrap labels them "#2"): one account's
    // quota runs out and the next carries on. Collapsing by provider would throw it away.
    expect(clients).toHaveLength(2);
  });

  it('collapses a genuinely repeated account', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'anthropic', account: 'default' }, 'k1');

    const clients = await opsChatClients(
      agentConfig({
        fallbacks: [
          { provider: 'claude', transport: 'api', credential: { service: 'anthropic', account: 'default' }, models: {} },
        ],
      }),
      credentials,
    );

    expect(clients).toHaveLength(1);
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

describe('what the editor may offer', () => {
  it('lists the models the config actually named, per provider', () => {
    const agents = opsUsableAgents(
      agentConfig({
        models: { planning: 'opus', implementation: 'sonnet', review: 'opus' },
        fallbacks: [
          { provider: 'gemini', transport: 'api', credential: { service: 'google', account: 'default' }, models: { implementation: 'flash' } },
        ],
      }),
    );

    // `opus` once, not twice — the same model named for two stages is one choice.
    expect(agents).toEqual([
      { provider: 'claude', models: ['opus', 'sonnet'], defaultModel: 'sonnet' },
      { provider: 'gemini', models: ['flash'], defaultModel: 'flash' },
    ]);
  });

  it('includes a cli provider that can be run without tools', () => {
    // A CLI entry needs no key in the config; the binary carries its own login (CRL-42).
    const agents = opsUsableAgents(
      agentConfig({
        transport: 'cli',
        credential: undefined,
        fallbacks: [
          { provider: 'gemini', transport: 'api', credential: { service: 'google', account: 'default' }, models: { implementation: 'flash' } },
        ],
      }),
    );

    expect(agents.map((a) => a.provider)).toEqual(['claude', 'gemini']);
  });

  it('does not offer a cli provider whose tools cannot be turned off', () => {
    // The editor must not let someone build a pipeline that can only be asked unsafely.
    const agents = opsUsableAgents(
      agentConfig({
        transport: 'cli',
        credential: undefined,
        fallbacks: [{ provider: 'gpt', transport: 'cli', models: {} }],
      }),
    );

    expect(agents.map((a) => a.provider)).toEqual(['claude']);
  });

});

describe('cli transports for a core with no key', () => {
  it('builds one from the same registry the development AI uses', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));

    const transports = await opsCliTransports(agentConfig({ transport: 'cli', credential: undefined }), credentials);

    expect(transports.map((t) => `${t.provider}:${t.transport}`)).toEqual(['claude:cli']);
  });

  it('leaves out a provider whose cli cannot be run without tools', async () => {
    // Measured, not assumed (CRL-43): codex still runs the shell under `-s read-only`,
    // which is enough to read a secret and return it inside the answer. gemini could not
    // be measured, so it stays out rather than being guessed at.
    const credentials = new FileCredentialStore(join(dir, 'c.json'));

    const transports = await opsCliTransports(
      agentConfig({
        transport: 'cli',
        credential: undefined,
        fallbacks: [
          { provider: 'gemini', transport: 'cli', models: {} },
          { provider: 'gpt', transport: 'cli', models: {} },
        ],
      }),
      credentials,
    );

    expect(transports.map((t) => t.provider)).toEqual(['claude']);
  });

  it('leaves api entries alone — those are the other runner\'s', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));
    await credentials.set({ service: 'anthropic', account: 'default' }, 'k1');

    expect(await opsCliTransports(agentConfig({}), credentials)).toEqual([]);
  });

  it('keeps one per provider — a CLI login is not per-account the way a key is', async () => {
    const credentials = new FileCredentialStore(join(dir, 'c.json'));

    const transports = await opsCliTransports(
      agentConfig({
        transport: 'cli',
        credential: undefined,
        fallbacks: [{ provider: 'claude', transport: 'cli', models: {} }],
      }),
      credentials,
    );

    expect(transports).toHaveLength(1);
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
