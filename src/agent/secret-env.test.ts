/**
 * How a credential reaches the container.
 *
 * It used to ride in the arguments — `docker exec -e CLAUDE_CODE_OAUTH_TOKEN=… ` — and a
 * command line is not private on Linux. `/proc/<pid>/cmdline` is `-r--r--r--`; measured on
 * the operational VM, an unprivileged second account read the running turn's token in full.
 * Anyone with a login on the host had the user's key or subscription token (CRL-125).
 *
 * The process environment is a different thing (`/proc/<pid>/environ` is owner-only), so the
 * local backend is unchanged and only the docker path moved.
 *
 * These drive the transports through the real `runCliTurn` with `spawn` replaced, because
 * the interesting failure is not in any one function: the first attempt built `secretEnv`
 * correctly in two transports and forgot to put it in the returned spec. Nothing failed to
 * compile — the field is optional — and the credential would simply have gone missing. So
 * the assertions read what actually arrives on the descriptor.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: Array<{ command: string; args: string[]; stdio: unknown[]; fdContent: string | null }> = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], opts: { stdio: unknown[] }) => {
    // Read the descriptor while it is still open — the runner closes it as soon as the
    // child has inherited it.
    const slot = opts.stdio[3];
    let fdContent: string | null = null;
    if (typeof slot === 'number') fdContent = readFileSync(slot, 'utf8');
    spawnCalls.push({ command, args, stdio: opts.stdio, fdContent });

    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable };
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  },
}));

const { ClaudeCliTransport } = await import('./claude-cli.js');
const { CodexCliTransport } = await import('./codex-cli.js');
const { GeminiCliTransport } = await import('./gemini-cli.js');
const { SECRET_ENV_PATH } = await import('./cli-runner.js');
const io = { writeFile: async () => {}, readFile: async () => null } as never;

const turn = (backend: 'docker' | 'local') =>
  ({
    handle: { id: 'ISS-1', workdir: '/workspace', backend },
    io,
    prompt: 'do it',
    workflow: '', // skip the guide write; nothing here is about the workspace
    continueSession: false,
  }) as never;

beforeEach(() => {
  spawnCalls.length = 0;
});

const SECRETS = [
  ['claude API key', () => new ClaudeCliTransport('sk-ant-api03-SECRET'), 'sk-ant-api03-SECRET', 'ANTHROPIC_API_KEY'],
  ['claude OAuth token', () => new ClaudeCliTransport(null, 'sk-ant-oat01-SECRET'), 'sk-ant-oat01-SECRET', 'CLAUDE_CODE_OAUTH_TOKEN'],
  ['openai API key', () => new CodexCliTransport('sk-proj-SECRET'), 'sk-proj-SECRET', 'OPENAI_API_KEY'],
  ['codex subscription auth', () => new CodexCliTransport(null, 'eyJhbGciOiJSUzI1NiJ9-SECRET'), 'eyJhbGciOiJSUzI1NiJ9-SECRET', 'CODEX_AUTH_B64'],
  ['gemini API key', () => new GeminiCliTransport('AIzaSy-SECRET'), 'AIzaSy-SECRET', 'GEMINI_API_KEY'],
] as const;

describe('a credential never reaches the command line', () => {
  it.each(SECRETS)('%s', async (_label, make, secret) => {
    await make().run(turn('docker'), () => {});

    const call = spawnCalls.at(-1)!;
    expect(call.command).toBe('docker');
    expect(call.args.join(' ')).not.toContain(secret);
    expect(call.args.some((a) => a.startsWith('-e'))).toBe(false);
  });

  it.each(SECRETS)('%s still arrives, on the descriptor', async (_label, make, secret, varName) => {
    await make().run(turn('docker'), () => {});

    const call = spawnCalls.at(-1)!;
    // The half a compiler cannot check: an optional field left out of the returned spec
    // drops the credential silently and the turn just fails to authenticate.
    expect(call.args).toContain('--env-file');
    expect(call.args).toContain(SECRET_ENV_PATH);
    expect(call.fdContent).toBe(`${varName}=${secret}\n`);
  });
});

describe('when there is no credential to pass', () => {
  it('opens no descriptor and asks for no env file', async () => {
    await new GeminiCliTransport(null).run(turn('docker'), () => {});

    const call = spawnCalls.at(-1)!;
    expect(call.args).not.toContain('--env-file');
    expect(call.stdio[3]).toBe('ignore');
    expect(call.fdContent).toBeNull();
  });
});

describe('the local backend', () => {
  it('is left as it was — the environment is owner-only, a command line is not', async () => {
    await new ClaudeCliTransport(null, 'sk-ant-oat01-SECRET').run(turn('local'), () => {});

    const call = spawnCalls.at(-1)!;
    expect(call.command).toBe('claude');
    expect(call.args.join(' ')).not.toContain('sk-ant-oat01-SECRET');
    // No file, no descriptor: the credential is in the process environment.
    expect(call.args).not.toContain('--env-file');
    expect(call.stdio[3]).toBe('ignore');
  });
});

describe('stdin', () => {
  it('stays closed', async () => {
    // `--env-file /dev/stdin` was the first idea and it fails on Linux (a pipe's fd path
    // cannot be opened). It would also have put stdin back in play, which is the thing
    // `cli-runner` closes on purpose — codex `exec` blocks reading it.
    await new CodexCliTransport('sk-proj-SECRET').run(turn('docker'), () => {});
    expect(spawnCalls.at(-1)!.stdio[0]).toBe('ignore');
  });
});

describe('a credential that would break the file format', () => {
  it('is refused instead of quietly declaring a second variable', async () => {
    // An env file is one KEY=VALUE per line with no quoting.
    const transport = new GeminiCliTransport('AIza-first\nEVIL=second');
    await expect(transport.run(turn('docker'), () => {})).rejects.toThrow(/line break/);
  });
});
