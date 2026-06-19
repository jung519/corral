/**
 * Thin promise wrapper around child_process.spawn. Captures stdout/stderr/exit
 * code without throwing on non-zero exit (callers decide what a failure means).
 *
 * Lifted from upstream.
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin then closed. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function run(command: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      signal: opts.signal,
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    }

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Run a command and throw if it exits non-zero. */
export async function runOrThrow(command: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const result = await run(command, args, opts);
  if (result.code !== 0) {
    throw new Error(`command failed (${result.code}): ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
}
