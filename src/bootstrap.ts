/** Builds the wired orchestrator from a (validated) config. The HTTP control plane
 * is owned by the entrypoint (main.ts) so it can run in "setup mode" before any
 * config exists. Missing credentials are NOT fatal — they resolve to empty and the
 * relevant action fails later with an auth error, so the app always boots. */
import { createAgent } from './agent/index.js';
import { channels } from './channel/index.js';
import { loadConfig } from './config/loader.js';
import type { Config } from './config/schema.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import type { CredentialRef, CredentialStore } from './credentials/types.js';
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
}

export async function bootstrap(config: Config, deps: BootstrapDeps = {}): Promise<App> {
  const credentials = deps.credentials ?? new EnvCredentialStore();
  const resolveSecret = async (ref: CredentialRef): Promise<string> => (await credentials.get(ref)) ?? '';

  const tracker = trackers.create(config.tracker, { token: await resolveSecret(config.tracker.credential) });

  const repositoryList: RepositoryAdapter[] = [];
  for (const repo of config.repositories) {
    repositoryList.push(repositoryRegistry.create(repo, { token: await resolveSecret(repo.credential) }));
  }

  const workspace = workspaces.create({ kind: config.workspace.backend, ...config.workspace }, {});

  const resolvedKey = config.agent.credential ? await resolveSecret(config.agent.credential) : '';
  const agent = createAgent(config.agent, { apiKey: resolvedKey || null, io: workspace.io });

  const channel = deps.channel ?? channels.create({ kind: config.channel.kind, port: config.channel.port }, undefined);

  const profile = resolveProfile(config.profile);
  const repositoryRouter = new RepositoryRouter(repositoryList);
  const orchestrator = new Orchestrator(config, tracker, repositoryRouter, workspace, agent, channel, profile);

  return { config, profile, tracker, repositories: repositoryList, repositoryRouter, agent, workspace, channel, orchestrator };
}

export async function bootstrapFromFile(path: string, deps?: BootstrapDeps): Promise<App> {
  return bootstrap(await loadConfig(path), deps);
}
