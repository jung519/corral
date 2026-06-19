/**
 * WorkspaceIO for the local backend — plain Node fs + git in the host workdir.
 * Lifted from upstream.
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkspaceIO } from '../core/types.js';
import { run } from '../util/exec.js';

export const localIO: WorkspaceIO = {
  async readFile(handle, path) {
    try {
      return await readFile(join(handle.workdir, path), 'utf8');
    } catch {
      return null;
    }
  },

  async writeFile(handle, path, content) {
    const full = join(handle.workdir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  },

  async exists(handle, path) {
    try {
      await access(join(handle.workdir, path));
      return true;
    } catch {
      return false;
    }
  },

  async list(handle, dir) {
    try {
      return await readdir(join(handle.workdir, dir));
    } catch {
      return [];
    }
  },

  async getDiff(handle, baseCommit) {
    const result = await run('git', ['diff', `${baseCommit}..HEAD`], { cwd: handle.workdir });
    return result.stdout;
  },

  async exec(handle, command) {
    const result = await run('bash', ['-lc', command], { cwd: handle.workdir });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  },
};
