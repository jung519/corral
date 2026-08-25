/**
 * SSH tunnel supervisor — the app's own tunnel, so reaching a remote core is not homework.
 *
 * ## Why this exists
 * The core binds loopback only and the control plane is authenticated but **not
 * encrypted** (`src/control-plane/ws.ts`), so the one safe way to reach a remote core is
 * a tunnel. Until this module existed the product said so and stopped there: the UI told
 * you to "use a tunnel", the server guide told you to leave `ssh -N -L …` running in a
 * terminal, and nothing made one. When that terminal closed — or the laptop slept — the
 * app showed an empty dashboard with no hint that a tunnel was the missing piece.
 *
 * ## Why it sits above the socket
 * `remote.ts` already retries the WebSocket with backoff. Against a missing tunnel that
 * retry can only ever say "reconnecting", forever, about a port that isn't there. The
 * distinction the operator needs is "the tunnel is down", so the tunnel's state is owned
 * here and reported separately (`index.ts` starts the socket only once we are `up`).
 *
 * ## Why these ssh options
 * - `ExitOnForwardFailure=yes` — without it ssh happily stays connected when the forward
 *   fails, so the process being alive would mean nothing.
 * - `BatchMode=yes` — a spawned ssh that decides to prompt for a passphrase waits for a
 *   terminal that does not exist and hangs invisibly. Better to fail with a reason.
 * - `ServerAliveInterval` / `CountMax` — a link killed by sleep or a network change is
 *   otherwise a half-open socket that neither side notices.
 * - `StrictHostKeyChecking` is left at the user's own ssh config: this connects to their
 *   server with their keys, and silently accepting new host keys on their behalf is not
 *   ours to decide.
 *
 * ## Readiness
 * Confirmed by connecting to the local port, not by reading ssh's output. Version- and
 * locale-dependent stderr text is not something to build a state machine on.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

/** Retry pacing, mirroring the socket's own backoff so the two feel alike. */
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** How often to test the local port while waiting for the forward to come up. */
const PROBE_INTERVAL_MS = 250;
/** Give up on a single attempt after this long and retry — a hung connect is a failure. */
const READY_TIMEOUT_MS = 20_000;
/** Enough stderr to name a cause without pasting a wall of text into the UI. */
const STDERR_KEEP = 400;

export interface TunnelConfig {
  /** ssh destination: `user@host`, or a host alias from the user's ssh config. */
  target: string;
  /** Port the core listens on over there (loopback on that machine). */
  remotePort: number;
  /** Port we bind here. Same number by default, so the address stays predictable. */
  localPort: number;
  /** Optional identity file, when the user's default key isn't the right one. */
  identityFile?: string;
}

/**
 * `failed` is terminal-ish: retries continue unless `fatal` is set, which marks the
 * causes no amount of retrying can fix (no ssh binary, authentication refused).
 */
export type TunnelState = 'off' | 'starting' | 'up' | 'failed';

export interface TunnelStatus {
  state: TunnelState;
  /** Machine-readable cause, for the UI to translate. Set when `state === 'failed'`. */
  code?: 'ssh-not-found' | 'auth-failed' | 'forward-failed' | 'exited' | 'timeout';
  /** Raw tail of ssh's stderr. Shown as detail, never the only thing shown. */
  detail?: string;
  /** True when retrying cannot help and the operator has to act. */
  fatal?: boolean;
}

export interface TunnelHandlers {
  onStatus(status: TunnelStatus): void;
}

/** Build the argv. Exported so a test can assert the options without spawning ssh. */
export function tunnelArgs(cfg: TunnelConfig): string[] {
  const args = [
    '-N', // no remote command — this process exists only to carry the forward
    '-T', // no pty; nothing here reads a terminal
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
  ];
  if (cfg.identityFile) args.push('-i', cfg.identityFile, '-o', 'IdentitiesOnly=yes');
  args.push(cfg.target);
  return args;
}

/**
 * Read a cause out of ssh's own words.
 *
 * Only patterns that change what the operator should *do* are worth distinguishing;
 * everything else stays `exited` with the text attached.
 */
export function classifyStderr(text: string): { code: TunnelStatus['code']; fatal: boolean } {
  const t = text.toLowerCase();
  // BatchMode turns "ask for a password" into this, so it means "your key isn't set up".
  if (t.includes('permission denied') || t.includes('too many authentication failures')) {
    return { code: 'auth-failed', fatal: true };
  }
  if (t.includes('cannot listen to port') || t.includes('address already in use')) {
    return { code: 'forward-failed', fatal: true };
  }
  return { code: 'exited', fatal: false };
}

/** Does something accept connections on this local port yet? */
function portAccepts(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export class SshTunnel {
  private child: ChildProcess | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private readyDeadline = 0;
  private backoff = BACKOFF_START_MS;
  private stopped = true;
  private stderr = '';
  status: TunnelStatus = { state: 'off' };

  constructor(
    private readonly handlers: TunnelHandlers,
    private readonly cfg: TunnelConfig,
    /** Injectable for tests; defaults to the real ssh. */
    private readonly spawnFn: typeof spawn = spawn,
  ) {}

  private setStatus(status: TunnelStatus): void {
    this.status = status;
    this.handlers.onStatus(status);
  }

  get isUp(): boolean {
    return this.status.state === 'up';
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  private launch(): void {
    if (this.stopped || this.child) return;
    this.stderr = '';
    this.setStatus({ state: 'starting' });

    let child: ChildProcess;
    try {
      child = this.spawnFn('ssh', tunnelArgs(this.cfg), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      // Synchronous throw is rare, but treat it the same as a missing binary.
      this.fail({ state: 'failed', code: 'ssh-not-found', fatal: true });
      return;
    }
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep the tail: the useful line ("Permission denied") tends to come last.
      this.stderr = (this.stderr + String(chunk)).slice(-STDERR_KEEP);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      // ENOENT here is the whole reason decision 1 needed a named failure: on a machine
      // without ssh the honest answer is "no ssh", not an empty dashboard.
      const notFound = err.code === 'ENOENT';
      this.fail({
        state: 'failed',
        code: notFound ? 'ssh-not-found' : 'exited',
        detail: err.message,
        fatal: notFound,
      });
    });

    child.on('exit', () => {
      if (this.child !== child) return; // a newer attempt already took over
      this.child = undefined;
      this.clearProbe();
      const { code, fatal } = classifyStderr(this.stderr);
      this.fail({ state: 'failed', code, detail: this.stderr.trim() || undefined, fatal });
    });

    this.readyDeadline = Date.now() + READY_TIMEOUT_MS;
    this.probe();
  }

  /** Wait for the forward to actually carry traffic before calling ourselves up. */
  private probe(): void {
    this.clearProbe();
    if (this.stopped || !this.child) return;
    this.probeTimer = setTimeout(() => {
      void (async () => {
        if (this.stopped || !this.child) return;
        if (await portAccepts(this.cfg.localPort)) {
          this.backoff = BACKOFF_START_MS; // a good tunnel forgives the past
          this.setStatus({ state: 'up' });
          return;
        }
        if (Date.now() > this.readyDeadline) {
          // Alive but not forwarding, or forwarding somewhere unreachable. Kill and retry
          // rather than sitting in `starting` forever.
          this.child?.kill();
          return;
        }
        this.probe();
      })();
    }, PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  private clearProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
  }

  private fail(status: TunnelStatus): void {
    this.setStatus(status);
    if (status.fatal) return; // looping against this would only bury the reason
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.launch();
    }, delay);
    this.retryTimer.unref?.();
  }

  /**
   * Stop and leave nothing behind.
   *
   * The tunnel's lifetime is the app's (CRL-114 decision 3), so quitting must not leave an
   * orphan ssh holding a local port — the next launch would fail to bind it.
   */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearProbe();
    const child = this.child;
    this.child = undefined;
    child?.removeAllListeners();
    child?.kill();
    this.setStatus({ state: 'off' });
  }
}
