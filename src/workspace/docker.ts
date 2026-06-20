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
import type { WorkspaceConfig } from '../config/schema.js';
import { logger } from '../core/logger.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { run, runOrThrow } from '../util/exec.js';
import { dockerIO } from './docker-io.js';

const WORKDIR = '/workspace';

export interface DockerBackendOptions {
  image: string;
  memory?: string;
  cpus?: string;
  env?: Record<string, string>;
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

export function dockerOptionsFromConfig(cfg: WorkspaceConfig['docker'], imageOverride?: string): DockerBackendOptions {
  return {
    image: imageOverride ?? cfg?.image ?? 'corral-worker:latest',
    memory: cfg?.memory,
    cpus: cfg?.cpus,
    env: cfg?.env,
  };
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
