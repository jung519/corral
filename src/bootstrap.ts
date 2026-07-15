/** Builds the wired orchestrator from a (validated) config. The HTTP control plane
 * is owned by the entrypoint (main.ts) so it can run in "setup mode" before any
 * config exists. Missing credentials are NOT fatal — they resolve to empty and the
 * relevant action fails later with an auth error, so the app always boots. */
import { FailoverAgent, type FailoverMember } from './agent/failover.js';
import { createAgent } from './agent/index.js';
import { StageRoutingAgent } from './agent/stage-router.js';
import { channels } from './channel/index.js';
import { loadConfig } from './config/loader.js';
import type { AgentRoutingConfig, Config } from './config/schema.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import type { CredentialRef, CredentialStore } from './credentials/types.js';
import { DirectionCheckStore, DirectionStore } from './core/direction.js';
import type {
  AgentAdapter,
  ChannelAdapter,
  RepositoryAdapter,
  TrackerAdapter,
  WorkspaceAdapter,
} from './core/types.js';
import { Orchestrator } from './orchestrator.js';
import { type ResolvedProfile, resolveProfile } from './profile/index.js';
import { repositories as repositoryRegistry } from './repository/index.js';
import { RepositoryRouter } from './repository/router.js';
import { trackers } from './tracker/index.js';
import { codexAuthMounted } from './workspace/docker.js';
import { workspaces } from './workspace/index.js';

export interface App {
  config: Config;
  profile: ResolvedProfile;
  tracker: TrackerAdapter;
  repositories: RepositoryAdapter[];
  repositoryRouter: RepositoryRouter;
  agent: AgentAdapter;
  workspace: WorkspaceAdapter;
  channel: ChannelAdapter;
  orchestrator: Orchestrator;
}

export interface BootstrapDeps {
  /** Defaults to the env-var store (headless / CI). */
  credentials?: CredentialStore;
  /** Reuse an existing channel (the entrypoint shares one across setup + run). */
  channel?: ChannelAdapter;
  /** Global Direction reader (shared with the IPC host). Defaults to a fresh store. */
  directionStore?: DirectionStore;
  /** Direction validation state (consent + verified hashes), shared with the IPC host. */
  directionCheck?: DirectionCheckStore;
}

export async function bootstrap(config: Config, deps: BootstrapDeps = {}): Promise<App> {
  const credentials = deps.credentials ?? new EnvCredentialStore();
  const resolveSecret = async (ref: CredentialRef): Promise<string> => (await credentials.get(ref)) ?? '';

  const tracker = trackers.create(config.tracker, { token: await resolveSecret(config.tracker.credential) });

  const repositoryList: RepositoryAdapter[] = [];
  for (const repo of config.repositories) {
    repositoryList.push(repositoryRegistry.create(repo, { token: await resolveSecret(repo.credential) }));
  }

  // Mount the operator's live codex credential into containers instead of shipping a
  // base64 snapshot (which 401s as soon as the host rotates its refresh token). Never when
  // a gpt CLI member actually HAS an API key — that path rewrites auth.json and would
  // clobber the host's ChatGPT login through the mount. Test the RESOLVED secret, not the
  // ref: the wizard always emits a `credential` ref, key stored or not.
  const gptCliMembers = [config.agent, ...config.agent.fallbacks, ...Object.values(config.agent.stages ?? {})].filter(
    (m) => m.provider === 'gpt' && m.transport === 'cli',
  );
  const gptCliKeys = await Promise.all(gptCliMembers.map((m) => (m.credential ? resolveSecret(m.credential) : '')));
  const codexMounted = codexAuthMounted(config.workspace, gptCliKeys.some((k) => !!k));

  const workspace = workspaces.create(
    { kind: config.workspace.backend, ...config.workspace },
    { mountCodexAuth: codexMounted },
  );

  // Primary agent + ordered fallbacks → a single AgentAdapter that fails over when the
  // active agent's usage is exhausted. Each member resolves its own credentials (BYOK).
  // When the credential is mounted, its base64 snapshot must NOT be injected: the codex
  // prelude writes it IN PLACE over the mount, clobbering the host's live auth.json.
  const buildMember = async (r: AgentRoutingConfig, label: string): Promise<FailoverMember> => {
    const apiKey = r.credential ? await resolveSecret(r.credential) : '';
    let oauthToken = r.oauth_credential ? await resolveSecret(r.oauth_credential) : '';
    if (codexMounted && r.provider === 'gpt' && r.transport === 'cli') oauthToken = '';
    const adapter = createAgent(r, { apiKey: apiKey || null, oauthToken: oauthToken || null, io: workspace.io });
    return { adapter, label };
  };
  const primary = await buildMember(config.agent, `${config.agent.provider}:${config.agent.transport}`);
  const fallbacks = await Promise.all(
    config.agent.fallbacks.map((f, i) => buildMember(f, `${f.provider}:${f.transport} #${i + 2}`)),
  );
  const baseAgent = fallbacks.length ? new FailoverAgent([primary, ...fallbacks]) : primary.adapter;

  // Per-stage overrides → route each stage to its own agent (plan/build/review can be
  // different providers). Stages without an override use the base agent (with fallbacks).
  const stageAgent = async (stage: 'planning' | 'implementation' | 'review'): Promise<AgentAdapter> => {
    const o = config.agent.stages?.[stage];
    return o ? (await buildMember(o, `${o.provider}:${o.transport} (${stage})`)).adapter : baseAgent;
  };
  const agent = config.agent.stages
    ? new StageRoutingAgent({
        planning: await stageAgent('planning'),
        implementation: await stageAgent('implementation'),
        review: await stageAgent('review'),
      })
    : baseAgent;

  const channel = deps.channel ?? channels.create({ kind: config.channel.kind, port: config.channel.port }, undefined);

  const profile = resolveProfile(config.profile);
  const repositoryRouter = new RepositoryRouter(repositoryList);

  // Resolve the optional reference/conventions repo clone URL (token embedded for a
  // private GitHub repo). undefined → no reference repo is cloned.
  let referenceCloneUrl: string | undefined;
  if (config.profile.reference_repo) {
    const token = config.profile.reference_credential ? await resolveSecret(config.profile.reference_credential) : '';
    referenceCloneUrl = buildReferenceCloneUrl(config.profile.reference_repo, token);
  }

  const orchestrator = new Orchestrator(
    config,
    tracker,
    repositoryRouter,
    workspace,
    agent,
    channel,
    profile,
    referenceCloneUrl,
    deps.directionStore ?? new DirectionStore(),
    deps.directionCheck ?? new DirectionCheckStore(),
  );

  return { config, profile, tracker, repositories: repositoryList, repositoryRouter, agent, workspace, channel, orchestrator };
}

/** Build a clone URL for the reference repo. Accepts "owner/name" (→ GitHub) or a
 * full https URL; injects a token as x-access-token for github.com when provided. */
function buildReferenceCloneUrl(repo: string, token: string): string {
  if (/^https?:\/\//.test(repo)) {
    if (token && repo.startsWith('https://github.com/')) {
      return repo.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
    }
    return repo;
  }
  const base = token ? `https://x-access-token:${token}@github.com/` : 'https://github.com/';
  return `${base}${repo}.git`;
}

export async function bootstrapFromFile(path: string, deps?: BootstrapDeps): Promise<App> {
  return bootstrap(await loadConfig(path), deps);
}
