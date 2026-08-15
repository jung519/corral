/**
 * How the desktop reaches the core. Two transports exist:
 *
 *   local   the app forks the core itself and talks over the Node IPC channel
 *   remote  the core runs elsewhere (a VM) and the app connects over WebSocket
 *
 * Both move the same four control-plane messages, so everything above this line —
 * request correlation, ready-waiting, event relay — is written once (`index.ts`) and
 * neither transport knows about it.
 */

/** Message the core sends us (`res` / `event` / `ready`, plus the remote handshake). */
export interface CoreMessage {
  kind: string;
  id?: number;
  result?: unknown;
  error?: string;
  event?: unknown;
  /** `paired` carries the long-lived token to store. */
  token?: string;
  /** `denied` explains why the connection was refused. */
  reason?: string;
}

/** Connection state surfaced to the UI (the remote transport reconnects on its own). */
export type LinkState = 'connected' | 'connecting' | 'disconnected';

export interface CoreTransport {
  /** Begin connecting (or spawn, for local). Returns immediately. */
  start(): void;
  /** Stop and release everything. */
  stop(): void;
  /** Send one control-plane message. Throws when the link is down. */
  send(message: unknown): void;
  /** True when messages can be sent right now. */
  isUp(): boolean;
  readonly state: LinkState;
}

export interface TransportHandlers {
  /** A message arrived from the core. */
  onMessage(message: CoreMessage): void;
  /** The link dropped — in-flight requests must be rejected, not left hanging. */
  onDown(reason: string): void;
  /** Connection state changed (for the UI). */
  onState?(state: LinkState): void;
}
