import { describe, expect, it } from 'vitest';
import { bootstrap } from './bootstrap.js';
import { ConfigSchema } from './config/schema.js';
import type { CredentialRef, CredentialStore } from './credentials/types.js';

class MapStore implements CredentialStore {
  constructor(private readonly m: Record<string, string>) {}
  async get(ref: CredentialRef): Promise<string | null> {
    return this.m[`${ref.service}:${ref.account}`] ?? null;
  }
  async has(ref: CredentialRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const config = ConfigSchema.parse({
  tracker: {
    kind: 'notion',
    database_id: 'db_1',
    credential: { service: 'notion' },
    states: { planning: 'P', plan_review: 'PR', in_progress: 'IP', in_review: 'IR', done: 'D' },
    properties: { status: 'Status', identifier: 'ID' },
  },
  repositories: [{ kind: 'github', key: 'main', repo: 'acme/widgets', credential: { service: 'github' } }],
  agent: { provider: 'claude', transport: 'api', credential: { service: 'anthropic' } },
});

const fullStore = () =>
  new MapStore({ 'notion:default': 'ntn', 'github:default': 'ghp', 'anthropic:default': 'sk' });

describe('bootstrap', () => {
  it('wires all five adapters from config + resolved credentials', async () => {
    const app = await bootstrap(config, { credentials: fullStore() });
    expect(app.tracker.kind).toBe('notion');
    expect(app.repositories).toHaveLength(1);
    expect(app.repositories[0]?.key).toBe('main');
    expect(app.agent.kind).toBe('claude');
    expect(app.workspace.kind).toBe('local');
    expect(app.channel.kind).toBe('web');
  });

  it('fails with a clear message when a credential is missing', async () => {
    const noAgentKey = new MapStore({ 'notion:default': 'ntn', 'github:default': 'ghp' });
    await expect(bootstrap(config, { credentials: noAgentKey })).rejects.toThrow(
      /missing credential for agent.*CORRAL_ANTHROPIC_DEFAULT/s,
    );
  });

  it('derives a github clone url and branch name from config', async () => {
    const app = await bootstrap(config, { credentials: fullStore() });
    const repo = app.repositories[0]!;
    expect(repo.cloneUrl()).toBe('https://x-access-token:ghp@github.com/acme/widgets.git');
    expect(
      repo.branchNameFor({
        identifier: 'ISS-7',
        internalId: '',
        title: '',
        description: '',
        state: 'in_progress',
        labels: [],
        blockedBy: [],
        attachments: [],
      }),
    ).toBe('ISS-7');
  });
});
