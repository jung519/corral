/** Headless bootstrap: load config → resolve credentials → instantiate all five
 * adapters through their registries. Proves the skeleton wires entirely from
 * user-supplied config values (S1 DoD). The orchestrator loop is lifted in S2. */
import { createAgent } from './agent/index.js';
import { channels } from './channel/index.js';
import { WebChannel } from './channel/web.js';
import { DashboardServer } from './server/dashboard.js';
import { loadConfig } from './config/loader.js';
import type { Config } from './config/schema.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import { type CredentialRef, type CredentialStore, envVarNameFor } from './credentials/types.js';
import { logger } from './core/logger.js';
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
  /** Routes an issue's repoKey → repository. */
  repositoryRouter: RepositoryRouter;
  agent: AgentAdapter;
  workspace: WorkspaceAdapter;
  channel: ChannelAdapter;
  /** The wired state machine (control-plane-driven). */
  orchestrator: Orchestrator;
  /** HTTP control-plane server (present when channel.kind === 'web'). */
  server?: DashboardServer;
}

export interface BootstrapDeps {
  /** Defaults to the env-var store (headless / CI). */
  credentials?: CredentialStore;
}

export async function bootstrap(config: Config, deps: BootstrapDeps = {}): Promise<App> {
  const credentials = deps.credentials ?? new EnvCredentialStore();

  // Resolve secrets tolerantly: a missing credential does NOT block boot (so the
  // control plane / dashboard / setup wizard can start before keys are configured).
  // The relevant action fails later with a clear auth error when it actually needs it.
  const missing: string[] = [];
  const resolveSecret = async (ref: CredentialRef, what: string): Promise<string> => {
    const secret = await credentials.get(ref);
    if (!secret) {
      missing.push(`${what} → ${envVarNameFor(ref)}`);
      return '';
    }
    return secret;
  };

  const tracker = trackers.create(config.tracker, {
    token: await resolveSecret(config.tracker.credential, 'tracker'),
  });

  const repositoryList: RepositoryAdapter[] = [];
  for (const repo of config.repositories) {
    repositoryList.push(
      repositoryRegistry.create(repo, {
        token: await resolveSecret(repo.credential, `repository "${repo.key}"`),
      }),
    );
  }

  const workspace = workspaces.create({ kind: config.workspace.backend, ...config.workspace }, {});

  // The agent's API key (BYOK); optional for `cli` (the user may rely on their own
  // CLI login). An empty resolution is treated as "no key" (null).
  const resolvedKey = config.agent.credential ? await resolveSecret(config.agent.credential, 'agent') : '';
  const agent = createAgent(config.agent, { apiKey: resolvedKey || null, io: workspace.io });

  if (missing.length > 0) {
    logger.warn(`starting without some credentials (configure before running issues): ${missing.join(', ')}`);
  }
  const channel = channels.create({ kind: config.channel.kind, port: config.channel.port }, undefined);

  const profile = resolveProfile(config.profile);
  const repositoryRouter = new RepositoryRouter(repositoryList);
  const orchestrator = new Orchestrator(config, tracker, repositoryRouter, workspace, agent, channel, profile);

  // The web channel exposes a concrete control-plane surface; bind an HTTP server
  // to the orchestrator's commands so the core is drivable headless (and by the UI).
  const server =
    channel instanceof WebChannel
      ? new DashboardServer(config.channel.port, {
          snapshot: () => orchestrator.snapshot(),
          channel,
          listCandidates: () => orchestrator.listCandidates(),
          startIssue: (id) => orchestrator.startIssue(id),
          completeIssue: (id, force) => orchestrator.completeByUser(id, force),
          retryIssue: (id) => orchestrator.retry(id),
          refineIssue: (id, focus) => orchestrator.refinePlan(id, focus),
        })
      : undefined;

  return {
    config,
    profile,
    tracker,
    repositories: repositoryList,
    repositoryRouter,
    agent,
    workspace,
    channel,
    orchestrator,
    server,
  };
}

export async function bootstrapFromFile(path: string, deps?: BootstrapDeps): Promise<App> {
  return bootstrap(await loadConfig(path), deps);
}
