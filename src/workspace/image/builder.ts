/**
 * Builds the auto worker image from a rendered Dockerfile and checks the image cache.
 * The Dockerfile is fed via stdin with NO build context (it never COPYs local files —
 * project deps install at clone time), so a build needs no temp directory. Requires a
 * working `docker` CLI; callers gate on that.
 */
import { spawn } from 'node:child_process';
import { run } from '../../util/exec.js';

/** Cache tag for a worker image keyed by the manifest hash (see manifestHash). */
export function workerImageTag(hash: string): string {
  return `corral-worker:${hash}`;
}

/** True if an image with this tag already exists locally (cache hit → skip build). */
export async function imageExists(tag: string): Promise<boolean> {
  const res = await run('docker', ['image', 'inspect', tag]);
  return res.code === 0;
}

/** Build `tag` from the Dockerfile string, streaming combined output via onLog. */
export async function buildImage(
  dockerfile: string,
  tag: string,
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    // `docker build -t <tag> -` reads the Dockerfile from stdin with an empty context.
    const child = spawn('docker', ['build', '-t', tag, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const emit = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) onLog?.(line);
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', (err) => {
      onLog?.(`docker build error: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ ok: false, code: null });
    });
    child.on('close', (code) => resolve({ ok: code === 0, code }));
    child.stdin?.write(dockerfile);
    child.stdin?.end();
  });
}
