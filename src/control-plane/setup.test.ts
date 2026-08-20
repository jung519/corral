/**
 * The setup half of the control plane — what a remote core exposes so the wizard on a
 * laptop can configure the machine the core actually runs on.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChannel } from '../channel/web.js';
import { DirectionCheckStore, DirectionStore } from '../core/direction.js';
import { FileCredentialStore } from '../credentials/file-store.js';
import { dispatch, type ControlPlaneDeps } from './dispatch.js';
import { SetupHost } from './setup-host.js';

let dir: string;
let reloads: number;
let reloadResult: { ok: boolean; error?: string };
let deps: ControlPlaneDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-setup-'));
  reloads = 0;
  reloadResult = { ok: true };
  deps = {
    channel: new WebChannel(),
    orchestrator: () => undefined,
    directionStore: new DirectionStore(join(dir, 'direction.md')),
    directionCheck: new DirectionCheckStore(dir),
    setup: new SetupHost({
      configPath: join(dir, 'corral.yaml'),
      draftPath: join(dir, 'wizard-draft.json'),
      credentials: new FileCredentialStore(join(dir, 'credentials.json')),
      reload: async () => {
        reloads++;
        return reloadResult;
      },
    }),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (method: string, args: Record<string, unknown> = {}): Promise<any> => dispatch(method, args, deps);

describe('config over the control plane', () => {
  it('reports no config before setup', async () => {
    expect(await call('configGet')).toEqual({ exists: false, yaml: null, config: undefined, raw: undefined });
  });

  it('writes the config and brings the orchestrator up in place', async () => {
    const res = await call('configSet', { yaml: 'version: 1\n' });

    expect(res.ok).toBe(true);
    expect(reloads).toBe(1); // no respawn is possible on a remote core — it reloads itself
    expect(readFileSync(join(dir, 'corral.yaml'), 'utf8')).toBe('version: 1\n');
    // `version: 1` is not a config the schema accepts, so there is nothing to parse —
    // the text still comes back, which is what lets a screen say it is unreadable.
    expect(await call('configGet')).toEqual({ exists: true, yaml: 'version: 1\n', config: undefined, raw: { version: 1 } });
  });

  it('hands back the parsed config, defaults filled in', async () => {
    // The window has no YAML parser and no schema — it ships with zero runtime
    // dependencies — so this is the only way a screen can render what the config says.
    // Without it the settings screen could only draw from the wizard draft, and deleting
    // that file emptied the screen on a configured, running core (CRL-76).
    const yaml = `
profile: { language: ko, stack: nestjs }
tracker:
  kind: notion
  database_id: db-1
  credential: { service: notion, account: default }
  properties: { status: "Status", identifier: "ID" }
  states: { planning: todo, in_progress: doing, done: done }
repositories:
  - kind: github
    key: server
    repo: owner/name
    credential: { service: github, account: default }
agent:
  provider: claude
  transport: cli
  models: { planning: opus, implementation: sonnet, review: opus }
workspace: { backend: docker }
channel: { kind: web }
`;
    await call('configSet', { yaml });

    const got = await call('configGet');

    expect(got.exists).toBe(true);
    expect(got.config).toMatchObject({
      profile: { language: 'ko', stack: 'nestjs' },
      tracker: { kind: 'notion', database_id: 'db-1' },
      repositories: [{ key: 'server', repo: 'owner/name' }],
      agent: { provider: 'claude', transport: 'cli' },
      workspace: { backend: 'docker' },
      // Never written down, and the screen needs the value that will actually be used.
      max_active_issues: 3,
    });
  });

  it('separates what applies from what was written down', async () => {
    // The tracker's optional states default onto a core column, so a parsed config always
    // has them. A screen reading only the parsed form would show "detailed board" as
    // chosen and then write those defaults back as choices (CRL-77).
    await call('configSet', {
      yaml: `
tracker:
  kind: notion
  database_id: db-1
  credential: { service: notion, account: default }
  properties: { status: "S", identifier: "ID" }
  states: { planning: todo, in_progress: doing, done: done }
repositories: [{ kind: github, key: k, repo: o/n, credential: { service: github, account: default } }]
agent: { provider: claude, transport: cli, models: { planning: a, implementation: b, review: c } }
workspace: { backend: local }
channel: { kind: web }
`,
    });

    const got = await call('configGet');

    expect(got.config.tracker.states.plan_review).toBeDefined(); // the schema filled it in
    expect(got.raw.tracker.states.plan_review).toBeUndefined(); // nobody wrote it
  });

  it('keeps a block the wizard cannot write when it saves', async () => {
    // The wizard renders a whole document from the fields it models, so a hand-written
    // ceiling used to vanish the next time somebody changed a model name (CRL-77).
    await call('configSet', { yaml: 'agent: { provider: claude }\nreview:\n  rounds: 3\n' });

    // A second save from the wizard — no `review` in it, because it has no field for one.
    await call('configSet', { yaml: 'agent: { provider: gpt }\n' });

    const yaml = readFileSync(join(dir, 'corral.yaml'), 'utf8');
    expect(yaml).toContain('provider: gpt'); // the wizard's own change landed
    expect(yaml).toContain('rounds: 3'); // and the block it does not model survived
  });

  it('hands back the merged text without writing, for the app to write itself', async () => {
    // A local core is respawned after setup to pick up freshly stored secrets, so the app
    // writes the file. It asks for the merge rather than knowing what a config contains.
    await call('configSet', { yaml: 'agent: { provider: claude }\ncontrol_plane:\n  port: 4410\n' });

    const merged = await call('configMerge', { yaml: 'agent: { provider: gpt }\n' });

    expect(merged.yaml).toContain('port: 4410');
    // Asked, not written: the file on disk is untouched by this call.
    expect(readFileSync(join(dir, 'corral.yaml'), 'utf8')).toContain('provider: claude');
  });

  it('keeps the config but reports why it would not start', async () => {
    reloadResult = { ok: false, error: 'tracker unreachable' };

    const res = await call('configSet', { yaml: 'version: 1\n' });

    // The wizard needs the reason on screen, and the file must survive so the user can
    // fix one field rather than redo setup.
    expect(res).toMatchObject({ ok: false, error: 'tracker unreachable' });
    expect(existsSync(join(dir, 'corral.yaml'))).toBe(true);
  });
});

describe('secrets over the control plane', () => {
  it('takes a secret in and answers only whether it exists', async () => {
    const ref = { service: 'notion', account: 'default' };

    expect(await call('secretHas', ref)).toEqual({ has: false });
    expect(await call('secretSet', { ...ref, value: 'ntn_live_1' })).toEqual({ ok: true });
    expect(await call('secretHas', ref)).toEqual({ has: true });
    expect(await call('secretDelete', ref)).toEqual({ ok: true });
    expect(await call('secretHas', ref)).toEqual({ has: false });
  });

  it('never returns a secret value from any method', async () => {
    await call('secretSet', { service: 'notion', account: 'default', value: 'ntn_live_1' });

    // Anything reachable over the wire, dumped and searched for the secret itself.
    const surface = JSON.stringify([
      await call('configGet'),
      await call('secretHas', { service: 'notion', account: 'default' }),
      await call('draftGet'),
      await call('status'),
    ]);

    expect(surface).not.toContain('ntn_live_1');
  });

  it('rejects a half-specified ref instead of writing a colliding key', async () => {
    // The store's keyspace is flat "service:account"; a blank half would alias entries.
    expect(await call('secretSet', { service: 'notion', account: '', value: 'x' })).toMatchObject({ ok: false });
    expect(await call('secretHas', { service: 'notion', account: '' })).toEqual({ has: false });
  });
});

describe('draft and direction over the control plane', () => {
  it('round-trips the wizard draft', async () => {
    expect(await call('draftGet')).toEqual({ json: null });
    await call('draftSet', { json: '{"step":2}' });
    expect(await call('draftGet')).toEqual({ json: '{"step":2}' });
    await call('draftClear');
    expect(await call('draftGet')).toEqual({ json: null });
  });

  it('writes the direction the core itself reads back', async () => {
    await call('directionWrite', { text: 'ship small' });
    expect(await call('direction')).toMatchObject({ text: 'ship small' });
  });
});

describe('host probes', () => {
  it('refuses to run a binary named by the caller', async () => {
    // Over a remote plane the provider name is untrusted input; only the fixed table
    // of provider→binary may reach execFile.
    expect(await call('detectCli', { provider: 'claude; rm -rf /' })).toEqual({ installed: false });
    expect(await call('detectCli', { provider: 'echo' })).toEqual({ installed: false });
  });

  it('answers for a known provider without throwing', async () => {
    // Whether it is installed depends on the machine; the shape must not.
    expect(await call('detectCli', { provider: 'claude' })).toHaveProperty('installed');
    expect(await call('detectDocker')).toHaveProperty('available');
  });
});

describe('a core with no setup surface', () => {
  it('declines setup methods instead of throwing', async () => {
    const bare: ControlPlaneDeps = { ...deps, setup: undefined };

    expect(await dispatch('configGet', {}, bare)).toMatchObject({ ok: false });
    expect(await dispatch('secretSet', { service: 'a', account: 'b', value: 'c' }, bare)).toMatchObject({ ok: false });
  });
});

describe('the setup host on disk', () => {
  it('creates the config directory when it does not exist yet', async () => {
    const nested = join(dir, 'a', 'b', 'corral.yaml');
    const host = new SetupHost({
      configPath: nested,
      draftPath: join(dir, 'a', 'b', 'draft.json'),
      credentials: new FileCredentialStore(join(dir, 'c.json')),
      reload: async () => ({ ok: true }),
    });

    await host.configWrite('version: 1\n');

    expect(host.configRead()).toBe('version: 1\n');
  });

  it('treats an unreadable config as absent rather than crashing the core', () => {
    const host = new SetupHost({
      configPath: dir, // a directory, not a file
      draftPath: join(dir, 'draft.json'),
      credentials: new FileCredentialStore(join(dir, 'c.json')),
      reload: async () => ({ ok: true }),
    });

    expect(host.configRead()).toBe(null);
  });

  it('clears a draft that is already gone', () => {
    const host = new SetupHost({
      configPath: join(dir, 'corral.yaml'),
      draftPath: join(dir, 'draft.json'),
      credentials: new FileCredentialStore(join(dir, 'c.json')),
      reload: async () => ({ ok: true }),
    });

    writeFileSync(join(dir, 'draft.json'), '{}');
    host.draftClear();
    host.draftClear();

    expect(host.draftRead()).toBe(null);
  });
});
