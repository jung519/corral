/** Lightweight toast notifications (replaces alert()). Auto-dismiss after a delay;
 * click to dismiss early. */

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

let items = $state<Toast[]>([]);
let seq = 0;

export function toasts(): Toast[] {
  return items;
}

export function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
}

export function toast(message: string, kind: ToastKind = 'info'): void {
  const id = ++seq;
  items = [...items, { id, kind, message }];
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
}
