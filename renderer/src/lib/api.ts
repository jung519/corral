import type { Candidate, CommandResult, CorralEvent, StateResponse } from './types';

/** When the renderer is loaded from file:// (Electron), relative URLs don't reach
 * the control plane — point them at the localhost server (CORS is enabled there). */
export function apiBase(): string {
  return typeof location !== 'undefined' && location.protocol === 'file:' ? 'http://localhost:4400' : '';
}

async function post(path: string, body: unknown): Promise<CommandResult> {
  const res = await fetch(apiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as CommandResult;
}

export async function getState(): Promise<StateResponse> {
  return (await fetch(apiBase() + '/api/state')).json() as Promise<StateResponse>;
}

export async function getStatus(): Promise<{ configured: boolean }> {
  return (await fetch(apiBase() + '/api/status')).json() as Promise<{ configured: boolean }>;
}

export async function getCandidates(): Promise<Candidate[]> {
  const data = (await (await fetch(apiBase() + '/api/candidates')).json()) as { candidates: Candidate[] };
  return data.candidates;
}

export const startIssue = (identifier: string): Promise<CommandResult> => post('/api/start', { identifier });
export const completeIssue = (identifier: string, force = false): Promise<CommandResult> =>
  post('/api/complete', { identifier, force });
export const retryIssue = (identifier: string): Promise<CommandResult> => post('/api/retry', { identifier });
export const removeIssue = (identifier: string): Promise<CommandResult> => post('/api/remove', { identifier });
export const restartIssue = (identifier: string): Promise<CommandResult> => post('/api/restart', { identifier });
export const refineIssue = (identifier: string, focus: string): Promise<CommandResult> =>
  post('/api/refine', { identifier, focus });
export const approve = (id: string, selection?: string, text?: string): Promise<CommandResult> =>
  post('/api/action', { id, type: 'approve', selection, text });
export const feedback = (id: string, text: string): Promise<CommandResult> =>
  post('/api/action', { id, type: 'feedback', text });

export const setup = (input: {
  config: string;
  secrets: Array<{ service: string; account: string; value: string }>;
}): Promise<CommandResult> => post('/api/setup', input);

/** Subscribe to the SSE event stream; returns an unsubscribe fn. */
export function subscribeEvents(onEvent: (e: CorralEvent) => void): () => void {
  const es = new EventSource(apiBase() + '/events');
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as CorralEvent);
    } catch {
      /* ignore keep-alive / non-JSON */
    }
  };
  return () => es.close();
}
