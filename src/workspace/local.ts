/**
 * Local workspace backend — clones each issue's repo into a host directory under
 * `<root>/<identifier>`. Convenient for development; no isolation.
 * Lifted from upstream.
 */
import { access, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../core/logger.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { runOrThrow } from '../util/exec.js';
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
    await mkdir(this.root, { recursive: true });
    await rm(workdir, { recursive: true, force: true });

    logger.child(input.identifier).info(`cloning ${redact(input.cloneUrl)} → ${workdir}`);
    await runOrThrow('git', ['clone', '--branch', input.baseBranch, input.cloneUrl, workdir]);

    return { id: input.identifier, workdir, backend: 'local' };
  }

  async reattach(identifier: string): Promise<WorkspaceHandle | null> {
    const workdir = this.dirFor(identifier);
    try {
      await access(join(workdir, '.git'));
      return { id: identifier, workdir, backend: 'local' };
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
