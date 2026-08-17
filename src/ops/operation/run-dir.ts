/**
 * Somewhere for a CLI agent to run.
 *
 * A CLI transport is a process, and a process needs a working directory. The development
 * AI gets one from `workspace/` — a cloned repo, a container, a lifetime measured in
 * hours. An operational run has none of that: it is seconds long, touches no repository,
 * and the only file that matters is the answer the agent leaves behind.
 *
 * So the operational AI keeps its own, and `ops/` never reaches into `workspace/` (see
 * docs/module-boundaries.md). The types are shared — they live in `core/types.ts` — but
 * the implementation here is a temp folder and nothing else.
 *
 * What it deliberately does not do: git, and running commands on the agent's behalf.
 * Those are the parts of a workspace that exist because the development AI edits a
 * repository. Growing them here would be re-inventing the thing the boundary keeps out,
 * so they say so rather than half-work.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { WorkspaceHandle, WorkspaceIO } from '../../core/types.js';
import { logger } from '../../core/logger.js';

/** A place to run one operation, and the way to put it back. */
export interface RunDir {
  handle: WorkspaceHandle;
  io: WorkspaceIO;
  /** Absolute path, for reading the answer back without going through `io`. */
  path: string;
  dispose(): Promise<void>;
}

/**
 * Keep every path inside the directory.
 *
 * The agent is told where to write, but "told" is not "guaranteed" — the same reason the
 * answer is checked in code rather than trusted from the prompt. A `..` that walked out
 * of here would be writing into someone's home directory.
 */
function within(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`"${path}" is outside the run directory`);
  }
  return full;
}

class RunDirIO implements WorkspaceIO {
  constructor(private readonly root: string) {}

  async readFile(_handle: WorkspaceHandle, path: string): Promise<string | null> {
    try {
      return await readFile(within(this.root, path), 'utf8');
    } catch {
      return null;
    }
  }

  async writeFile(_handle: WorkspaceHandle, path: string, content: string): Promise<void> {
    const full = within(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  async exists(_handle: WorkspaceHandle, path: string): Promise<boolean> {
    try {
      await stat(within(this.root, path));
      return true;
    } catch {
      return false;
    }
  }

  async list(_handle: WorkspaceHandle, dir: string): Promise<string[]> {
    try {
      return await readdir(within(this.root, dir));
    } catch {
      return [];
    }
  }

  getDiff(): Promise<string> {
    // No repository here, so there is nothing to diff. Saying so beats returning ''.
    return Promise.reject(new Error('an operational run has no repository to diff'));
  }

  exec(): Promise<{ stdout: string; stderr: string; code: number }> {
    return Promise.reject(new Error('the operational AI does not run commands for the agent'));
  }
}

/** Make one. `id` only labels it — the agent never sees the name. */
export async function makeRunDir(id: string): Promise<RunDir> {
  const path = await mkdtemp(join(tmpdir(), 'corral-ops-'));
  return {
    path,
    handle: { id, workdir: path, backend: 'local' },
    io: new RunDirIO(path),
    async dispose() {
      // A run that failed must not leave its folder behind — thousands of runs a day
      // would fill the disk with them. Failing to clean up is worth a line, not a throw:
      // the answer is already delivered by this point.
      await rm(path, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn(`ops: could not remove ${path} — ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  };
}
