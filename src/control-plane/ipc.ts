/**
 * Control-plane transport: the parent process's Node IPC channel.
 *
 * The desktop forks the core with `stdio: [...,'ipc']`, so there is NO TCP port — the
 * renderer↔main bridge relays requests here over `process.send`/`process.on('message')`.
 * This file only moves messages; what a method *does* lives in `dispatch.ts`.
 */
import { logger } from '../core/logger.js';
import { bus } from '../core/events.js';
import { type ControlPlaneDeps, dispatch, type ReqMessage } from './dispatch.js';

export function startIpcHost(deps: ControlPlaneDeps): void {
  const send = process.send?.bind(process);
  if (!send) {
    logger.error('startIpcHost: no IPC channel (core was not forked with stdio:ipc)');
    return;
  }

  // Forward every bus event to the parent (replaces the SSE stream).
  bus.subscribe((event) => {
    try {
      send({ kind: 'event', event });
    } catch (err) {
      logger.warn('ipc event send failed', String(err));
    }
  });

  process.on('message', (raw: unknown) => {
    const msg = raw as ReqMessage;
    if (!msg || msg.kind !== 'req') return;
    void dispatch(msg.method, msg.args ?? {}, deps)
      .then((result) => send({ kind: 'res', id: msg.id, result }))
      .catch((err) => send({ kind: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) }));
  });

  send({ kind: 'ready' });
  logger.info('ipc control plane ready');
}
