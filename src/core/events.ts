/**
 * In-process event bus. Every component publishes progress events here; the
 * dashboard (HTTP+SSE) subscribes. A ring buffer keeps recent history so a newly
 * opened dashboard shows the timeline so far, not just future events.
 *
 * Lifted from upstream (renamed SymphonyEvent → CorralEvent).
 */
import { EventEmitter } from 'node:events';

export type EventKind =
  | 'phase' // phase transition
  | 'dispatch' // agent run start/end
  | 'activity' // live agent action (tool use / text / cost)
  | 'approval' // approval requested / received
  | 'notice' // generic info
  | 'error';

export interface CorralEvent {
  ts: number;
  identifier: string;
  kind: EventKind;
  label: string;
  phase?: string;
  data?: Record<string, unknown>;
}

const BUFFER_CAP = 2000;

class EventBus extends EventEmitter {
  private buffer: CorralEvent[] = [];

  emitEvent(e: Omit<CorralEvent, 'ts'>): void {
    const full: CorralEvent = { ...e, ts: Date.now() };
    this.buffer.push(full);
    if (this.buffer.length > BUFFER_CAP) this.buffer.shift();
    this.emit('event', full);
  }

  /** Recent events, optionally filtered to one issue. */
  recent(identifier?: string): CorralEvent[] {
    return identifier ? this.buffer.filter((e) => e.identifier === identifier) : [...this.buffer];
  }

  /** Drop buffered events for an issue (on completion/reset). */
  clear(identifier: string): void {
    this.buffer = this.buffer.filter((e) => e.identifier !== identifier);
  }

  subscribe(cb: (e: CorralEvent) => void): () => void {
    this.on('event', cb);
    return () => this.off('event', cb);
  }
}

export const bus = new EventBus();
