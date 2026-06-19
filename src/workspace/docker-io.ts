/**
 * WorkspaceIO for the docker backend — every operation runs via `docker exec`
 * against the issue's long-lived container. File contents are moved with base64
 * to stay safe regardless of quoting/binary-ish payloads.
 *
 * Lifted from upstream (container name symphony-<id> → corral-<id>).
 */
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { run } from '../util/exec.js';

const USER = 'worker';

function containerName(handle: WorkspaceHandle): string {
  return `corral-${handle.id}`;
}

/** docker exec <container> bash -lc '<cmd>' as the worker user. */
async function dexec(
  handle: WorkspaceHandle,
  cmd: string,
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const args = [
    'exec',
    '--user',
    USER,
    '-w',
    handle.workdir,
    ...(input !== undefined ? ['-i'] : []),
    containerName(handle),
    'bash',
    '-lc',
    cmd,
  ];
  const res = await run('docker', args, { input });
  return { stdout: res.stdout, stderr: res.stderr, code: res.code };
}

export const dockerIO: WorkspaceIO = {
  async readFile(handle, path) {
    const res = await dexec(handle, `cat ${shq(path)} 2>/dev/null | base64`);
    if (res.code !== 0) return null;
    const b64 = res.stdout.trim();
    if (!b64) return res.code === 0 ? '' : null;
    return Buffer.from(b64, 'base64').toString('utf8');
  },

  async writeFile(handle, path, content) {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const res = await dexec(handle, `mkdir -p "$(dirname ${shq(path)})" && base64 -d > ${shq(path)}`, b64);
    if (res.code !== 0) throw new Error(`writeFile failed: ${res.stderr}`);
  },

  async exists(handle, path) {
    const res = await dexec(handle, `test -e ${shq(path)}`);
    return res.code === 0;
  },

  async list(handle, dir) {
    const res = await dexec(handle, `ls -1 ${shq(dir)} 2>/dev/null`);
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(Boolean);
  },

  async getDiff(handle, baseCommit) {
    const res = await dexec(handle, `git diff ${shq(baseCommit)}..HEAD`);
    return res.stdout;
  },

  async exec(handle, command) {
    return dexec(handle, command);
  },
};

/** single-quote shell escaping. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
