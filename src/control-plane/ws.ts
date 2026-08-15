/**
 * Control-plane transport: WebSocket, for operating a core that runs somewhere else
 * (a VM). Same four-message protocol as the IPC transport — only the pipe differs, so
 * `dispatch.ts` is untouched and both transports can run at the same time.
 *
 * ## Why `ws` and not the platform
 * Neither Node nor Electron ships a WebSocket **server**, and Electron 33 (Node 20 —
 * where the desktop runs the core) has no WebSocket **client** either. `ws` is a
 * dependency-free pure-JS package, so it adds no native module and does not affect
 * cross-platform packaging.
 *
 * ## Security
 * Off unless configured, loopback by default, and **authenticated** (`auth.ts`): a client
 * pairs once with a short code, then presents a token. Until it authenticates a socket may
 * send nothing but the handshake, receives no events, and is dropped after a timeout.
 * There is no transport encryption — run it behind a tunnel/VPN, hence the warning when
 * bound to a non-loopback address.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';
import type { ControlPlaneAuth } from './auth.js';
import { type AuthMessage, type ControlPlaneDeps, dispatch, type OutMessage, type ReqMessage } from './dispatch.js';

/** Time a client has to authenticate before the socket is closed. */
const AUTH_TIMEOUT_MS = 10_000;

export interface WsHostOptions {
  host: string;
  port: number;
  /** Credential store. Omit ONLY in tests that exercise the transport itself. */
  auth?: ControlPlaneAuth;
}

export interface WsHost {
  /** Actual bound port (useful when the configured port was 0 — tests). */
  readonly port: number;
  /** Connected client count. */
  readonly clients: number;
  close(): Promise<void>;
}

/** Non-loopback hosts. Exposing an unauthenticated control plane there is dangerous. */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Start the WebSocket control plane. Resolves once the port is bound so callers (and
 * tests) know the real port.
 */
export function startWsHost(deps: ControlPlaneDeps, opts: WsHostOptions): Promise<WsHost> {
  if (!isLoopback(opts.host)) {
    logger.warn(
      `control plane bound to ${opts.host} — reachable beyond this machine and NOT encrypted. ` +
        `Put it behind a tunnel/VPN or bind 127.0.0.1.`,
    );
  }
  if (!opts.auth) logger.warn('control plane running WITHOUT authentication (tests only)');

  const wss = new WebSocketServer({ host: opts.host, port: opts.port });
  const sockets = new Set<WebSocket>();

  const sendTo = (socket: WebSocket, msg: OutMessage): void => {
    // A dead or slow socket must never take down the core: drop it and move on.
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn(`ws send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ONE bus subscription fanned out to every client — subscribing per socket would
  // duplicate events and leak on disconnect.
  const unsubscribe = bus.subscribe((event) => {
    for (const socket of sockets) sendTo(socket, { kind: 'event', event });
  });

  wss.on('connection', (socket) => {
    // An unauthenticated socket is only allowed to pair or authenticate; it never reaches
    // dispatch(). With no auth store (transport tests) the socket starts authenticated.
    let authed = !opts.auth;
    // Don't let unauthenticated sockets linger and hold resources.
    const authTimer = authed
      ? undefined
      : setTimeout(() => {
          logger.warn('ws: closing client that did not authenticate in time');
          socket.close();
        }, AUTH_TIMEOUT_MS);

    const pass = (): void => {
      authed = true;
      if (authTimer) clearTimeout(authTimer);
      sockets.add(socket); // only authenticated sockets receive the event fan-out
      logger.info(`control plane client connected (${sockets.size} total)`);
      // Unlike IPC (one parent, signalled once at startup), each client needs its own
      // ready as soon as it is allowed in.
      sendTo(socket, { kind: 'ready' });
    };

    const reject = (reason: string): void => {
      // Never echo the submitted code/token — logs must not become a credential leak.
      logger.warn(`ws: rejected client (${reason})`);
      sendTo(socket, { kind: 'denied', reason });
      socket.close();
    };

    if (authed) pass();

    socket.on('message', (raw) => {
      let msg: ReqMessage | AuthMessage;
      try {
        msg = JSON.parse(String(raw)) as ReqMessage | AuthMessage;
      } catch {
        logger.warn('ws: dropping unparseable message');
        return;
      }
      if (!msg) return;

      if (!authed) {
        const auth = opts.auth!;
        if (msg.kind === 'pair') {
          const token = auth.redeemCode(String(msg.code ?? ''), String(msg.label ?? 'client'));
          if (!token) return reject('invalid or expired pairing code');
          sendTo(socket, { kind: 'paired', token });
          pass();
        } else if (msg.kind === 'auth') {
          if (!auth.verifyToken(String(msg.token ?? ''))) return reject('invalid token');
          pass();
        } else {
          // Anything else before authenticating — including `req` — is refused.
          reject('not authenticated');
        }
        return;
      }

      if (msg.kind !== 'req' || typeof msg.id !== 'number') return;
      const req = msg;
      void dispatch(req.method, req.args ?? {}, deps)
        .then((result) => sendTo(socket, { kind: 'res', id: req.id, result }))
        .catch((err) =>
          sendTo(socket, { kind: 'res', id: req.id, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    socket.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      if (sockets.delete(socket)) logger.info(`control plane client disconnected (${sockets.size} left)`);
    });
    socket.on('error', (err) => {
      if (authTimer) clearTimeout(authTimer);
      logger.warn(`ws client error: ${err.message}`);
      sockets.delete(socket);
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      logger.info(`ws control plane listening on ${opts.host}:${port}`);
      resolve({
        get port() {
          return port;
        },
        get clients() {
          return sockets.size;
        },
        close: () =>
          new Promise((done) => {
            unsubscribe();
            for (const socket of sockets) socket.close();
            sockets.clear();
            wss.close(() => done());
          }),
      });
    });
  });
}
