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
 * Binds to loopback by default and is **off unless configured**. Authentication is a
 * separate milestone; until it lands, loopback + opt-in is the only barrier, so exposing
 * this on a public interface is logged as a warning.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';
import { type ControlPlaneDeps, dispatch, type OutMessage, type ReqMessage } from './dispatch.js';

export interface WsHostOptions {
  host: string;
  port: number;
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
      `control plane bound to ${opts.host} — reachable beyond this machine and NOT authenticated yet. ` +
        `Put it behind a tunnel/VPN or bind 127.0.0.1.`,
    );
  }

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
    sockets.add(socket);
    logger.info(`control plane client connected (${sockets.size} total)`);

    socket.on('message', (raw) => {
      let msg: ReqMessage;
      try {
        msg = JSON.parse(String(raw)) as ReqMessage;
      } catch {
        logger.warn('ws: dropping unparseable message');
        return;
      }
      if (!msg || msg.kind !== 'req' || typeof msg.id !== 'number') return;
      void dispatch(msg.method, msg.args ?? {}, deps)
        .then((result) => sendTo(socket, { kind: 'res', id: msg.id, result }))
        .catch((err) =>
          sendTo(socket, { kind: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        );
    });

    socket.on('close', () => {
      sockets.delete(socket);
      logger.info(`control plane client disconnected (${sockets.size} left)`);
    });
    socket.on('error', (err) => {
      logger.warn(`ws client error: ${err.message}`);
      sockets.delete(socket);
    });

    // Unlike IPC (one parent, signalled once at startup), each client needs its own
    // ready as soon as it attaches.
    sendTo(socket, { kind: 'ready' });
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
