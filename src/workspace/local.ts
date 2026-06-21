/**
 * Local workspace backend — clones each issue's repo into a host directory under
 * `<root>/<identifier>`. Convenient for development; no isolation.
 * Lifted from upstream.
 */
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../core/logger.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { run, runOrThrow } from '../util/exec.js';
import { localIO } from './local-io.js';

export class LocalWorkspace implements WorkspaceAdapter {
  readonly kind = 'local';
  readonly io: WorkspaceIO = localIO;

  constructor(private readonly root: string) {}

  private dirFor(identifier: string): string {
    return resolve(this.root, identifier);
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
    const workdir = this.dirFor(input.identifier);
    const log = logger.child(input.identifier);
    await mkdir(this.root, { recursive: true });
    await rm(workdir, { recursive: true, force: true });
    await mkdir(workdir, { recursive: true });

    // Clone every repo side by side into <workspace>/<key>; the agent runs at the
    // workspace root and decides which repo(s) an issue touches.
    for (const repo of input.repos) {
      const dest = join(workdir, repo.key);
      log.info(`cloning ${redact(repo.cloneUrl)} → ${dest}`);
      await runOrThrow('git', ['clone', '--branch', repo.baseBranch, repo.cloneUrl, dest]);
    }

    // Reference/conventions repos cloned read-only (shallow) alongside the work tree.
    for (const extra of input.extraRepos ?? []) {
      const dest = join(workdir, extra.path);
      log.info(`cloning reference repo → ${dest}`);
      const res = await run('git', ['clone', '--depth', '1', extra.cloneUrl, dest]);
      if (res.code !== 0) log.warn(`reference clone failed (${extra.path})`, res.stderr.slice(-300));
    }

    return { id: input.identifier, workdir, backend: 'local' };
  }

  async reattach(identifier: string): Promise<WorkspaceHandle | null> {
    const workdir = this.dirFor(identifier);
    try {
      // Present if at least one repo subdir still has a .git.
      for (const e of await readdir(workdir)) {
        try {
          await access(join(workdir, e, '.git'));
          return { id: identifier, workdir, backend: 'local' };
        } catch {
          /* not a repo dir */
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async cleanup(handle: WorkspaceHandle): Promise<void> {
    await rm(handle.workdir, { recursive: true, force: true });
    logger.child(handle.id).info('workspace removed');
  }
}

/** git URLs may embed a token — never log it verbatim. */
function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
