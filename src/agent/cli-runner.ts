/**
 * Provider-neutral CLI turn runner. Spawns a coding-agent CLI, streams its
 * line-delimited output through a provider-specific parser, and emits normalized
 * AgentEvents — identical lifecycle (timeout → SIGTERM, auth/crash detection, usage
 * aggregation) for every provider so claude/gemini/codex transports stay thin.
 *
 * The provider differences live in two injected pieces: the CliSpawnSpec (binary,
 * flags, env) and the CliStreamParser (how to read that CLI's stream format).
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Logger } from '../core/logger.js';
import { looksLikeAuth, looksLikeRateLimit, type UsageAcc } from './stream-json.js';
import { priceFor } from './pricing.js';
import type { AgentEvent, AgentProviderId, AgentTurnSpec } from './types.js';

/** How to read one CLI's stream output, normalized to AgentEvents. */
export interface CliStreamParser<T> {
  /**
   * Which model family this CLI drives.
   *
   * Reading the usage out of the stream is this interface's job, and the price is the last
   * step of that: two of the three CLIs report tokens and no money, so without this the
   * day's cost silently omitted whatever they spent (CRL-86).
   */
  readonly provider: AgentProviderId;
  /** Parse one stdout line into a provider event, or null for non-JSON noise. */
  parse(line: string): T | null;
  /** Normalized activity events (text / tool_use) for the live timeline. */
  activity(event: T): AgentEvent[];
  /** The assistant's text, uncapped — for `spec.onAnswerText`. Omit when this CLI's
   *  stream cannot supply it; the turn then simply reports no answer text. */
  answerText?(event: T): string | null;
  /** Fold this event's cost/token data into the accumulator. */
  usage(event: T, acc: UsageAcc): void;
  /** Whether this event signals an auth/credential failure (non-retryable). The raw
   *  line is passed so parsers can keyword-match the serialized error text. */
  isAuthFailure(event: T, rawLine: string): boolean;
  /** Optional: whether this event signals the usage/rate limit was hit (fail-over
   *  trigger). The raw line is passed for keyword matching. */
  isRateLimit?(event: T, rawLine: string): boolean;
  /** Optional: emit any buffered output at end-of-stream (stateful parsers only).
   *  Stateful parsers MUST be instantiated per turn — never shared across turns. */
  flush?(): AgentEvent[];
}

/**
 * Where a container reads the turn's credentials from — the value to pass to
 * `docker exec --env-file`.
 *
 * `/dev/fd/N` rather than `/proc/self/fd/N`: macOS has no `/proc` and the desktop app runs
 * the docker backend there; on Linux the two are the same thing. Both were measured.
 *
 * A pipe cannot be used here. `--env-file /dev/stdin` works on macOS and fails on Linux
 * with `no such device or address` — docker opens the path, and a pipe's fd path cannot be
 * opened that way. So the fd behind this is a real file (see `openSecretEnv`).
 */
export const SECRET_ENV_PATH = '/dev/fd/3';
/** Must match the index the fd is passed at in `stdio` below. */
const SECRET_ENV_FD = 3;

/** What to spawn for one turn. */
export interface CliSpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /**
   * The turn's credentials, delivered out of band rather than in `args`.
   *
   * Command-line arguments are not private on Linux: `/proc/<pid>/cmdline` is
   * world-readable, and any account on the host can read it while the turn runs — measured
   * on the operational VM with an unprivileged second account. Passing `-e TOKEN=…` therefore
   * published the user's API key or subscription token to everyone on the box (CRL-125).
   *
   * The process environment is a different thing: `/proc/<pid>/environ` is owner-only. That
   * is why the local backend still injects through `env` above and is left alone.
   */
  secretEnv?: Record<string, string>;
}

/**
 * Put the credentials on a file descriptor and take the file's name away.
 *
 * The bytes reach disk for the moment it takes to write them — under `0600` inside a `0700`
 * directory — and then the name is unlinked, so by the time docker runs there is no path for
 * anyone to open and nothing left behind if this process dies. What survives is one fd,
 * which `/proc/<pid>/fd` shows to the owner only.
 */
function openSecretEnv(env: Record<string, string>): { fd: number; close: () => void } {
  const lines = Object.entries(env).map(([k, v]) => {
    // An env-file is one `KEY=VALUE` per line with no quoting, so a line break in a value
    // would quietly declare a second variable. None of the credentials can contain one;
    // the check costs nothing and the alternative is finding out the hard way.
    if (/[\r\n]/.test(v)) throw new Error(`credential ${k} contains a line break and cannot be passed to the container`);
    return `${k}=${v}`;
  });
  const dir = mkdtempSync(join(tmpdir(), 'corral-env-'));
  const file = join(dir, 'env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  const fd = openSync(file, 'r');
  unlinkSync(file);
  rmSync(dir, { recursive: true, force: true });
  return {
    fd,
    close: () => {
      try {
        closeSync(fd);
      } catch {
        // Already closed — the turn ending twice is not worth an error.
      }
    },
  };
}

/** Run one CLI turn: spawn, stream-parse, and resolve after the final `done` event. */
export function runCliTurn<T>(
  spec: AgentTurnSpec,
  spawnSpec: CliSpawnSpec,
  parser: CliStreamParser<T>,
  onEvent: (event: AgentEvent) => void,
  log: Logger,
): Promise<void> {
  // Opened before the spawn so a malformed credential fails here, with a name attached,
  // rather than as an unexplained container error.
  const secret = spawnSpec.secretEnv ? openSecretEnv(spawnSpec.secretEnv) : undefined;
  return new Promise<void>((resolve) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      signal: spec.signal,
      // Close stdin (none of the CLIs take piped input) — codex `exec` otherwise blocks
      // reading stdin; claude/gemini ignore it. stdout/stderr stay piped for parsing.
      // fd 3, when present, carries the credentials the container reads via
      // `--env-file ${SECRET_ENV_PATH}` — stdin stays closed, so nothing about codex changes.
      // One shape either way so stdout/stderr stay typed as pipes; with no credential to
      // pass, fd 3 is simply /dev/null and no CLI looks at it.
      stdio: ['ignore', 'pipe', 'pipe', secret ? secret.fd : 'ignore'],
    });
    // The child has inherited it; this process has no further use for it.
    secret?.close();
    const acc: UsageAcc = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    // Accumulated across the whole turn: a long reply arrives as several text blocks.
    let answer = '';
    let sawAuth = false;
    let sawRateLimit = false;
    let timedOut = false;
    let stderr = '';

    const timeoutMs = spec.turnTimeoutMs;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          log.warn(`turn timeout (${timeoutMs}ms) — SIGTERM`);
          child.kill('SIGTERM');
        }, timeoutMs)
      : undefined;

    // Both are pipes by construction; `spawn`'s narrowing overloads only cover a
    // three-entry stdio, and fd 3 puts this past them.
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const event = parser.parse(line);
      if (!event) return;
      for (const e of parser.activity(event)) onEvent(e);
      if (spec.onAnswerText && parser.answerText) {
        const t = parser.answerText(event);
        if (t) answer += t;
      }
      parser.usage(event, acc);
      if (parser.isAuthFailure(event, line)) sawAuth = true;
      if (parser.isRateLimit?.(event, line)) sawRateLimit = true;
    });

    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (looksLikeAuth(stderr)) sawAuth = true;
      if (looksLikeRateLimit(stderr)) sawRateLimit = true;
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      log.error('agent spawn error', String(err));
      onEvent({ type: 'usage', ...acc });
      onEvent({ type: 'error', error: 'crashed', message: String(err) });
      onEvent({ type: 'done', exitCode: null });
      resolve();
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (parser.flush) for (const e of parser.flush()) onEvent(e);
      if (answer) spec.onAnswerText?.(answer);
      // A CLI that reports its own cost is believed: it knows the account's terms, which
      // may include a plan no price table can express. The table only stands in where the
      // CLI says nothing — codex and gemini report tokens and no money, and counting those
      // turns as free made the day's total wrong by however much they spent (CRL-86).
      if (acc.costUsd === 0 && (acc.inputTokens > 0 || acc.outputTokens > 0)) {
        acc.costUsd = priceFor(parser.provider, spec.model, acc.inputTokens, acc.outputTokens, acc.input);
      }
      onEvent({ type: 'usage', inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, costUsd: acc.costUsd });
      // rate_limit before auth: a spent quota is auto-recoverable (fail over), whereas
      // auth needs manual re-auth — don't misreport a usage limit as the latter.
      if (sawRateLimit) onEvent({ type: 'error', error: 'rate_limit' });
      // Split auth: a turn that produced ZERO tokens never authenticated → it's a
      // credential/login setup problem (login_required), NOT capacity exhaustion. A turn
      // that ran (tokens > 0) and THEN hit auth is a mid-run session/account end (auth).
      else if (sawAuth)
        onEvent({ type: 'error', error: acc.inputTokens === 0 && acc.outputTokens === 0 ? 'login_required' : 'auth' });
      else if (timedOut) onEvent({ type: 'error', error: 'timeout' });
      else if (code !== 0) onEvent({ type: 'error', error: 'crashed', message: stderr.slice(-300) });
      log.info(`agent done code=${code} cost=$${acc.costUsd.toFixed(4)} tok=${acc.inputTokens}/${acc.outputTokens}`);
      onEvent({ type: 'done', exitCode: code });
      resolve();
    });
  });
}

/** Single-quote shell escaping for embedding args in `bash -lc "<cmd>"` (docker exec). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
