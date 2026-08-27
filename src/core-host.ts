/**
 * Everything a running core needs, independent of who launched it.
 *
 * Two entrypoints share this: `ipc-main.ts` (forked by the Electron app, talks over the
 * process IPC channel) and `main.ts` (headless — a VM or a server, where the WebSocket
 * plane is the only way in). They differ in how clients reach the core, not in what the
 * core is, so that difference is all their files contain.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { WebChannel } from './channel/web.js';
import { loadConfig } from './config/loader.js';
import type { ControlPlaneConfig } from './config/schema.js';
import { ControlPlaneAuth } from './control-plane/auth.js';
import type { ControlPlaneDeps } from './control-plane/dispatch.js';
import { SetupHost } from './control-plane/setup-host.js';
import { startWsHost, type WsHost } from './control-plane/ws.js';
import { DirectionCheckStore, DirectionStore } from './core/direction.js';
import { TokenBudget } from './core/token-budget.js';
import { logger } from './core/logger.js';
import { EnvCredentialStore } from './credentials/env-store.js';
import { opsChatClients, opsCliTransports, opsModelFor, opsUsableAgents } from './ops/operation/clients.js';
import { CliTurnOperationRunner } from './ops/operation/cli-turn.js';
import { OneTurnOperationRunner } from './ops/operation/one-turn.js';
import { startOpsHost } from './ops/ops-host.js';
import { FileCredentialStore } from './credentials/file-store.js';
import { LayeredCredentialStore } from './credentials/layered.js';
import type { Orchestrator } from './orchestrator.js';

export interface CoreHostOptions {
  /** Process arguments, minus the runtime and script (i.e. `process.argv.slice(2)`). */
  argv: string[];
  /**
   * Headless runs force the WebSocket plane on: it is the only way to reach the core,
   * so leaving it to config would make a fresh install unreachable — and unable to
   * receive the config that would open it. A desktop core leaves it off unless asked,
   * because the process IPC channel already serves its one trusted client.
   */
  requirePlane: boolean;
}

export interface CoreHost {
  deps: ControlPlaneDeps;
  /** Bound WebSocket plane, when one is running. */
  ws?: WsHost;
  /** Stop serving and let in-flight work settle. Safe to call twice. */
  shutdown(): Promise<void>;
}

/** Read `--name value`. Present with no value yields '' (so `--pair` alone works). */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : (argv[i + 1]?.startsWith('--') ? '' : (argv[i + 1] ?? ''));
}

/**
 * Where the WebSocket plane should listen — `--control-plane [host:]port`, else
 * `CORRAL_CONTROL_PLANE`, else the config, else the headless default.
 *
 * The flag and env exist for the case config cannot cover: a core with no config yet.
 * Setup happens over this plane, so requiring config to open it would be circular.
 * Returns undefined when nothing asked for it and nothing requires it.
 */
export function resolvePlane(
  argv: string[],
  env: NodeJS.ProcessEnv,
  config: ControlPlaneConfig | undefined,
  requirePlane: boolean,
): { host: string; port: number } | undefined {
  const explicit = flag(argv, '--control-plane') || env.CORRAL_CONTROL_PLANE;
  if (explicit) {
    const [a, b] = explicit.split(':');
    const [host, port] = b === undefined ? ['127.0.0.1', a] : [a, b];
    const n = Number(port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`invalid control plane address "${explicit}" — expected [host:]port`);
    }
    return { host: host || '127.0.0.1', port: n };
  }
  if (config?.enabled) return { host: config.host, port: config.port };
  // Loopback by default: reachable through an SSH tunnel, not from the open internet.
  if (requirePlane) return { host: '127.0.0.1', port: 4410 };
  return undefined;
}

export async function startCoreHost(opts: CoreHostOptions): Promise<CoreHost> {
  const { argv, requirePlane } = opts;
  const configPath = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'corral.yaml');
  const stateDir = resolve(process.env.CORRAL_STATE_DIR ?? '.corral-state');

  const fileStore = new FileCredentialStore(resolve(stateDir, 'credentials.json'));
  const credentials = new LayeredCredentialStore([new EnvCredentialStore(), fileStore], fileStore);
  const channel = new WebChannel();
  const directionStore = new DirectionStore();
  const directionCheck = new DirectionCheckStore(stateDir);
  const auth = new ControlPlaneAuth(stateDir);

  let orchestrator: Orchestrator | undefined;
  let channelStarted = false;
  // ONE counter for both pillars. Rebuilt on reload so a limit change takes effect, but
  // the day's tally is on disk — editing the config does not hand back spent tokens.
  let budget = new TokenBudget({}, stateDir);

  /**
   * Build the orchestrator from the config now on disk and run it — the startup path and
   * also what `configSet` calls after the setup wizard writes a config.
   *
   * Order matters: bootstrap first, swap second. A config that fails to build (bad token,
   * unreachable tracker) then leaves the running orchestrator untouched instead of taking
   * the core down. Errors come back to the caller rather than throwing, so the wizard can
   * show why.
   */
  const reload = async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const config = await loadConfig(configPath);
      budget = new TokenBudget(
        {
          dailyInputTokens: config.limits.daily_input_tokens,
          dailyOutputTokens: config.limits.daily_output_tokens,
          dailyCostUsd: config.limits.daily_cost_usd,
        },
        stateDir,
      );
      ops.useBudget(budget);
      const app = await bootstrap(config, { credentials, channel, directionStore, directionCheck, budget });
      orchestrator?.stop();
      orchestrator = app.orchestrator;
      // The operational AI asks the same providers the development one does (D24). Only
      // `api` entries qualify; with none, its model step stays unwired and says so.
      const clients = await opsChatClients(config.agent, credentials);
      const cliTransports = await opsCliTransports(config.agent, credentials);
      // The editor asks for this so it can offer only what can answer.
      ops.useAgents(opsUsableAgents(config.agent));
      // API first when both are configured: one HTTP call against a process spawn, for a
      // step that runs thousands of times a day. The CLI is what makes a core with only a
      // subscription login able to run pipelines at all.
      const modelFor = opsModelFor(config.agent);
      if (clients.length) ops.useOperation(new OneTurnOperationRunner({ clients, modelFor }));
      else if (cliTransports.length) ops.useOperation(new CliTurnOperationRunner({ transports: cliTransports, modelFor }));
      else logger.warn('ops: no provider configured — pipelines cannot run their model step');
      if (!channelStarted) {
        await channel.start();
        channelStarted = true;
      }
      await orchestrator.start();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // The operational AI runs alongside the development one, sharing this core's state
  // directory and control plane but none of its code — the wall `ops/boundaries.test.ts`
  // checks. It
  // needs no config: with no pipeline files on disk it simply has nothing to run.
  const ops = await startOpsHost({ stateDir, credentials, budget });

  const deps: ControlPlaneDeps = {
    channel,
    orchestrator: () => orchestrator,
    directionStore,
    directionCheck,
    setup: new SetupHost({ configPath, draftPath: resolve(stateDir, 'wizard-draft.json'), credentials, reload }),
    ops,
  };

  // `--revoke <label|all>` drops paired clients. One-shot, before we start serving.
  const revoke = flag(argv, '--revoke');
  if (revoke !== undefined) {
    const removed = auth.revoke(revoke || 'all');
    logger.info(`revoked ${removed} control-plane token(s)${revoke ? ` for "${revoke}"` : ''}`);
  }

  let planeConfig: ControlPlaneConfig | undefined;
  if (existsSync(configPath)) {
    // Whether the plane listens is decided once, here. A later `configSet` that turns it
    // on takes effect on the next start — you can't open the door you're already standing
    // in — so `--control-plane` exists for when you need it open right now.
    try {
      planeConfig = (await loadConfig(configPath)).control_plane;
    } catch {
      /* reload() reports the real reason below */
    }
    const started = await reload();
    // Config present but failed to start — surface it, but keep serving so a client can
    // still read status and fix or redo setup.
    if (started.ok) logger.info('corral configured — orchestrator running');
    else logger.error(`config present but failed to start: ${started.error}`);
  } else {
    logger.info('corral starting in setup mode (no config yet)');
  }

  let ws: WsHost | undefined;
  const plane = resolvePlane(argv, process.env, planeConfig, requirePlane);
  if (plane) {
    // Show a pairing code when nobody has paired yet, or when --pair asks for another
    // device. Existing clients keep working with their tokens, so we stay quiet otherwise.
    if (!auth.hasTokens() || flag(argv, '--pair') !== undefined) {
      logger.info(`control plane pairing code: ${auth.issueCode()} (valid 5 minutes, single use)`);
    } else {
      logger.info(`control plane: ${auth.listLabels().length} paired client(s) — run with --pair to add one`);
    }

    try {
      ws = await startWsHost(deps, { host: plane.host, port: plane.port, auth });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // Headless has no other way in — a core nobody can reach is worse than a failed
      // start, so say so and let the caller exit. With process IPC we can carry on.
      if (requirePlane) throw new Error(`control plane failed to start on ${plane.host}:${plane.port} — ${why}`);
      logger.error(`ws control plane failed to start: ${why}`);
    }
  }

  let down = false;
  return {
    deps,
    ws,
    async shutdown() {
      if (down) return;
      down = true;
      await ws?.close();
      await ops.stop(); // release trigger subscriptions before anything else winds down
      orchestrator?.stop();
      await channel.stop();
      // Issues mid-flight are not abandoned: their state is on disk, and the next start
      // reattaches to their workspaces (Orchestrator.recover). Nothing to drain here.
    },
  };
}
