/**
 * Docker workspace backend — one container per issue (`corral-<identifier>`),
 * started with `sleep infinity` and kept alive across dispatches (reused via
 * docker exec).
 *
 * Lifted from upstream. KEY ADAPTATION (BYOK): the host `~/.claude` OAuth mount is
 * removed — Corral never shares an operator's subscription login. Provider auth is
 * the agent transport's concern (API key / the user's own CLI login); any env the
 * orchestrator needs to inject goes through DockerBackendOptions.env.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceConfig } from '../config/schema.js';
import { logger } from '../core/logger.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { run, runOrThrow } from '../util/exec.js';
import { dockerIO, WORKER_USER } from './docker-io.js';

const WORKDIR = '/workspace';

/** The host's codex credential. Mounting THIS FILE (not all of `~/.codex`) keeps the
 *  container on the operator's live login without dragging in the host `config.toml`,
 *  which overrides the container's and routes codex to the API endpoint (401). */
export function hostCodexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json');
}

/**
 * True when the container should mount the host codex credential instead of receiving a
 * base64 snapshot. A snapshot goes stale the moment the host refreshes (codex ROTATES the
 * refresh token → `refresh_token_reused` 401); one shared file cannot.
 *
 * ⚠️ Deliberately NOT gated on `mount_host_login`. That flag is about mounting the host
 * `~/.claude` directory — a different provider with a different auth story. Operators turn
 * it off because claude authenticates by key/OAuth, which silently disabled codex auth too
 * and left the review stage failing with `login_required`. Codex has no other working
 * subscription path under docker, so it gets its own decision.
 *
 * `codexUsesApiKey` MUST be true whenever any gpt CLI member authenticates with an API key:
 * that path runs `codex login --with-api-key`, which REWRITES auth.json — and an in-place
 * write passes straight through the bind mount, destroying the operator's ChatGPT login.
 */
export function codexAuthMounted(cfg: WorkspaceConfig, codexUsesApiKey = false): boolean {
  if (cfg.backend !== 'docker' || codexUsesApiKey) return false;
  return existsSync(hostCodexAuthPath());
}

export interface DockerBackendOptions {
  image: string;
  memory?: string;
  cpus?: string;
  env?: Record<string, string>;
  /** Mount the host ~/.claude login into the container (read-only) so the CLI
   *  authenticates without an API key. */
  mountHostLogin?: boolean;
  /** Mount the host codex credential file (~/.codex/auth.json) read-write, so the
   *  container shares the operator's live login instead of a snapshot that goes stale. */
  mountCodexAuth?: boolean;
}

export class DockerWorkspace implements WorkspaceAdapter {
  readonly kind = 'docker';
  readonly io: WorkspaceIO = dockerIO;

  constructor(private readonly opts: DockerBackendOptions) {}

  private name(identifier: string): string {
    return `corral-${identifier}`;
  }

  private handle(identifier: string): WorkspaceHandle {
    return { id: identifier, workdir: WORKDIR, backend: 'docker' };
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
    const name = this.name(input.identifier);
    const log = logger.child(input.identifier);
    const image = input.image ?? this.opts.image; // per-repo override (e.g. node vs flutter)

    // Remove any stale container with the same name.
    await run('docker', ['rm', '-f', name]);

    const args = ['run', '-d', '--name', name, '-w', WORKDIR];
    if (this.opts.memory) args.push('--memory', this.opts.memory);
    if (this.opts.cpus) args.push('--cpus', this.opts.cpus);
    for (const [k, v] of Object.entries(this.opts.env ?? {})) args.push('-e', `${k}=${v}`);
    // Mount the host Claude login read-only so the CLI authenticates without an API key.
    if (this.opts.mountHostLogin) args.push('-v', `${homedir()}/.claude:/home/${WORKER_USER}/.claude:ro`);
    // Same idea for codex, but credential-file only and READ-WRITE: codex refreshes the
    // token in place (an in-place write passes through a file bind mount), so host and
    // container stay on ONE credential — no stale snapshot to go 401.
    if (this.opts.mountCodexAuth) {
      args.push('-v', `${hostCodexAuthPath()}:/home/${WORKER_USER}/.codex/auth.json`);
    }
    args.push(image, 'sleep', 'infinity');

    log.info(`starting container ${name} (${image})`);
    await runOrThrow('docker', args);

    const handle = this.handle(input.identifier);
    // Clone every repo side by side into /workspace/<key>; the agent runs at the
    // workspace root and decides which repo(s) an issue touches.
    for (const repo of input.repos) {
      const dest = `${WORKDIR}/${repo.key}`;
      log.info(`cloning ${redact(repo.cloneUrl)} → ${dest}`);
      const clone = await this.io.exec(
        handle,
        `git clone --branch ${shq(repo.baseBranch)} ${shq(repo.cloneUrl)} ${shq(dest)}`,
      );
      if (clone.code !== 0) {
        // Log the reason to the per-issue file (not just the thrown error) so a setup
        // failure — e.g. a missing base branch on a newly-added repo — is diagnosable
        // from the log alone, not only the transient "Setup failed" UI event.
        log.error(`clone failed (${repo.key}, branch ${repo.baseBranch})`, clone.stderr.slice(-400));
        await this.cleanup(handle);
        throw new Error(`clone failed (${repo.key}): ${clone.stderr}`);
      }
    }

    // Reference repos (e.g. a conventions repo) cloned read-only alongside the work tree.
    for (const extra of input.extraRepos ?? []) {
      log.info(`cloning reference repo → ${extra.path}`);
      const res = await this.io.exec(handle, `git clone --depth 1 ${shq(extra.cloneUrl)} ${shq(extra.path)}`);
      if (res.code !== 0) log.warn(`reference clone failed (${extra.path})`, res.stderr.slice(-300));
    }
    return handle;
  }

  async reattach(identifier: string): Promise<WorkspaceHandle | null> {
    const res = await run('docker', [
      'ps',
      '-a',
      '--filter',
      `name=^/${this.name(identifier)}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (!res.stdout.trim()) return null;
    // Make sure it's running (it may be stopped after a host reboot).
    await run('docker', ['start', this.name(identifier)]);
    return this.handle(identifier);
  }

  async cleanup(handle: WorkspaceHandle): Promise<void> {
    await run('docker', ['rm', '-f', this.name(handle.id)]);
    logger.child(handle.id).info('container removed');
  }
}

/** Whether the Docker daemon is reachable — not just the CLI installed. A stopped
 *  Docker Desktop makes `docker info` exit non-zero; checking up front lets the
 *  orchestrator give a clear message instead of a cryptic image-build failure. */
export async function dockerDaemonRunning(): Promise<boolean> {
  const res = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 8000 });
  return res.code === 0 && res.stdout.trim().length > 0;
}

export function dockerOptionsFromConfig(
  cfg: WorkspaceConfig['docker'],
  imageOverride?: string,
  mountCodexAuth = false,
): DockerBackendOptions {
  return {
    image: imageOverride ?? cfg?.image ?? 'corral-worker:latest',
    memory: cfg?.memory,
    cpus: cfg?.cpus,
    env: cfg?.env,
    mountHostLogin: cfg?.mount_host_login ?? true,
    // Guarded twice: bootstrap decides (it knows the agent config), and the source file
    // must exist — a missing source path makes docker create a DIRECTORY at the mount
    // point, which breaks codex entirely.
    mountCodexAuth: mountCodexAuth && existsSync(hostCodexAuthPath()),
  };
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
