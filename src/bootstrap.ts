/** Headless bootstrap: load config → resolve credentials → instantiate all five
 * adapters through their registries. Proves the skeleton wires entirely from
 * user-supplied config values (S1 DoD). The orchestrator loop is lifted in S2. */
import { createAgent } from './agent/index.js';
import { channels } from './channel/index.js';
import { loadConfig } from './config/loader.js';
import type { Config } from './config/schema.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import { type CredentialRef, type CredentialStore, envVarNameFor } from './credentials/types.js';
import type {
  AgentAdapter,
  ChannelAdapter,
  RepositoryAdapter,
  TrackerAdapter,
  WorkspaceAdapter,
} from './core/types.js';
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
  /** Routes an issue's repoKey → repository. */
  repositoryRouter: RepositoryRouter;
  agent: AgentAdapter;
  workspace: WorkspaceAdapter;
  channel: ChannelAdapter;
}

export interface BootstrapDeps {
  /** Defaults to the env-var store (headless / CI). */
  credentials?: CredentialStore;
}

export async function bootstrap(config: Config, deps: BootstrapDeps = {}): Promise<App> {
  const credentials = deps.credentials ?? new EnvCredentialStore();

  const requireSecret = async (ref: CredentialRef, what: string): Promise<string> => {
    const secret = await credentials.get(ref);
    if (!secret) {
      throw new Error(
        `missing credential for ${what} (service="${ref.service}", account="${ref.account}"); ` +
          `set ${envVarNameFor(ref)}`,
      );
    }
    return secret;
  };

  const tracker = trackers.create(config.tracker, {
    token: await requireSecret(config.tracker.credential, 'tracker'),
  });

  const repositoryList: RepositoryAdapter[] = [];
  for (const repo of config.repositories) {
    repositoryList.push(
      repositoryRegistry.create(repo, {
        token: await requireSecret(repo.credential, `repository "${repo.key}"`),
      }),
    );
  }

  const workspace = workspaces.create({ kind: config.workspace.backend, ...config.workspace }, {});

  // The agent's API key (BYOK) is resolved when a credential is configured. It is
  // required for `api` (enforced by the schema) and optional for `cli` (the user
  // may rely on their own CLI login instead).
  const apiKey = config.agent.credential ? await requireSecret(config.agent.credential, 'agent') : null;
  const agent = createAgent(config.agent, { apiKey, io: workspace.io });
  const channel = channels.create({ kind: config.channel.kind, port: config.channel.port }, undefined);

  return {
    config,
    profile: resolveProfile(config.profile),
    tracker,
    repositories: repositoryList,
    repositoryRouter: new RepositoryRouter(repositoryList),
    agent,
    workspace,
    channel,
  };
}

export async function bootstrapFromFile(path: string, deps?: BootstrapDeps): Promise<App> {
  return bootstrap(await loadConfig(path), deps);
}
