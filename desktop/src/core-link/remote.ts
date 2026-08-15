/**
 * Remote transport: the core runs somewhere else (a VM) and we reach it over WebSocket.
 *
 * ## Handshake
 * The core refuses everything until the socket authenticates:
 *   - have a token  → `{kind:'auth', token}`
 *   - no token yet  → `{kind:'pair', code}` (a code the operator reads from the core log),
 *                     the core answers `{kind:'paired', token}` and we store it
 *
 * ## Reconnect
 * A remote link drops for ordinary reasons — the tunnel restarts, the VM reboots, the
 * laptop sleeps. We retry with exponential backoff and re-authenticate automatically, so
 * the operator never has to reconnect by hand. In-flight requests are rejected on drop
 * rather than left hanging.
 *
 * ## Why `ws`
 * Electron 33 runs Node 20, which has no global WebSocket, so the platform can't do this.
 */
import { WebSocket } from 'ws';
import type { CoreMessage, CoreTransport, LinkState, TransportHandlers } from './types.js';

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface RemoteOptions {
  url: string;
  /** Stored token, if this client has paired before. */
  token?: string;
  /** One-time pairing code, used when there is no token yet. */
  pairingCode?: string;
  /** Shown in the core's token list so devices are distinguishable when revoking. */
  label?: string;
  /** Called once pairing succeeds so the caller can persist the token. */
  onPaired?(token: string): void;
  /** Called when the core refuses us — a wrong/expired code or a revoked token. Retrying
   *  cannot fix this, so the caller should surface it instead of silently looping. */
  onDenied?(reason: string): void;
}

export class RemoteTransport implements CoreTransport {
  private socket: WebSocket | undefined;
  private backoff = BACKOFF_START_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private authed = false;
  private stopped = false;
  state: LinkState = 'disconnected';

  constructor(
    private readonly handlers: TransportHandlers,
    private opts: RemoteOptions,
  ) {}

  private setState(state: LinkState): void {
    this.state = state;
    this.handlers.onState?.(state);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.authed = false;
    this.setState('connecting');

    const socket = new WebSocket(this.opts.url);
    this.socket = socket;

    socket.on('open', () => {
      // Authenticate immediately: the core drops sockets that stay silent.
      if (this.opts.token) socket.send(JSON.stringify({ kind: 'auth', token: this.opts.token }));
      else if (this.opts.pairingCode)
        socket.send(
          JSON.stringify({ kind: 'pair', code: this.opts.pairingCode, label: this.opts.label ?? 'desktop' }),
        );
      // Neither: we can't authenticate. Let the core's timeout close us; the UI is
      // expected to collect a pairing code before enabling remote mode.
    });

    socket.on('message', (raw) => {
      let msg: CoreMessage;
      try {
        msg = JSON.parse(String(raw)) as CoreMessage;
      } catch {
        return; // ignore garbage rather than tearing the link down
      }

      if (msg.kind === 'paired' && msg.token) {
        // Pairing spends the code; keep the token for every later connection.
        this.opts = { ...this.opts, token: msg.token, pairingCode: undefined };
        this.opts.onPaired?.(msg.token);
        return;
      }
      if (msg.kind === 'denied') {
        this.opts.onDenied?.(msg.reason ?? 'denied');
        // Don't reconnect in a loop against a credential problem.
        this.stop();
        return;
      }
      if (msg.kind === 'ready') {
        this.authed = true;
        this.backoff = BACKOFF_START_MS; // a good connection resets the penalty
        this.setState('connected');
      }
      this.handlers.onMessage(msg);
    });

    const drop = (reason: string): void => {
      if (this.socket !== socket) return; // a newer socket already took over
      this.socket = undefined;
      this.authed = false;
      this.setState('disconnected');
      this.handlers.onDown(reason);
      this.scheduleRetry();
    };

    socket.on('close', () => drop('remote core connection closed'));
    socket.on('error', (err) => {
      // 'error' is followed by 'close'; log here and let close() handle the teardown.
      console.warn(`[core-link] remote error: ${err.message}`);
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.authed = false;
    socket?.removeAllListeners();
    socket?.close();
    this.setState('disconnected');
    this.handlers.onDown('remote link stopped');
  }

  send(message: unknown): void {
    if (!this.isUp()) throw new Error('remote core not connected');
    this.socket!.send(JSON.stringify(message));
  }

  /** Up only once authenticated — before that the core would refuse the request anyway. */
  isUp(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.authed;
  }
}
