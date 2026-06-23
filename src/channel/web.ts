/**
 * WebChannel — the dashboard is the control plane. Approval requests become pending
 * actions the UI renders (plan/review as HTML); the user approves / gives feedback
 * via POST. No polling: the user's click is the signal.
 *
 * Lifted from upstream. The HTTP server lives in ../server/dashboard.ts; this class
 * holds the pending-action + diff state and the approve/feedback callbacks.
 */
import { marked } from 'marked';
import { bus } from '../core/events.js';
import { logger } from '../core/logger.js';
import type { ApprovalDetail, ApprovalRequest, ChannelAdapter } from '../core/types.js';

// breaks: true → honor the agent's single newlines as <br> (GitHub-style). Review
// findings put the file ref and the detail on separate lines without a blank line
// between them; without this they collapse into one dense paragraph.
marked.setOptions({ gfm: true, breaks: true });

export interface PendingAction {
  id: string;
  identifier: string;
  kind: string;
  title: string;
  /** Original markdown. */
  body: string;
  /** Rendered HTML for the UI. */
  bodyHtml: string;
  options?: string[];
  createdAt: number;
}

export interface IssueDiff {
  filename: string;
  diff: string;
}

export class WebChannel implements ChannelAdapter {
  readonly kind = 'web';
  private readonly pending = new Map<string, PendingAction>();
  private readonly diffs = new Map<string, IssueDiff[]>();
  private approveCb?: (id: string, detail?: ApprovalDetail) => void;
  private feedbackCb?: (id: string, text: string) => void;
  private seq = 0;
  /** Stamp source for createdAt — injectable so tests are deterministic. */
  private now: () => number = () => Date.now();

  async start(): Promise<void> {
    logger.info('web channel ready (dashboard is the control plane)');
  }

  async stop(): Promise<void> {}

  async sendApproval(req: ApprovalRequest): Promise<string> {
    const id = `act-${++this.seq}-${req.identifier}`;
    // Supersede any earlier pending action for the same issue.
    for (const [pid, p] of this.pending) if (p.identifier === req.identifier) this.pending.delete(pid);
    this.pending.set(id, {
      id,
      identifier: req.identifier,
      kind: req.kind,
      title: req.title,
      body: req.body,
      bodyHtml: renderMarkdown(req.body),
      options: req.options,
      createdAt: this.now(),
    });
    bus.emitEvent({ identifier: req.identifier, kind: 'approval', label: `🔔 Action needed: ${kindLabel(req.kind)}` });
    return id;
  }

  async notify(identifier: string, text: string): Promise<void> {
    bus.emitEvent({ identifier, kind: 'notice', label: text });
  }

  async uploadDiff(identifier: string, filename: string, diff: string): Promise<void> {
    const list = this.diffs.get(identifier) ?? [];
    list.push({ filename, diff });
    this.diffs.set(identifier, list);
  }

  onApprove(cb: (id: string, detail?: ApprovalDetail) => void): void {
    this.approveCb = cb;
  }

  onFeedback(cb: (id: string, text: string) => void): void {
    this.feedbackCb = cb;
  }

  // ── called by the web server ──

  getPending(): PendingAction[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Remove a pending action the orchestrator superseded (e.g. on re-vet / retry). */
  resolve(id: string): void {
    this.pending.delete(id);
  }

  getDiffs(identifier: string): IssueDiff[] {
    return this.diffs.get(identifier) ?? [];
  }

  submitApprove(id: string, detail?: ApprovalDetail): boolean {
    const action = this.pending.get(id);
    if (!action) return false;
    this.pending.delete(id);
    logger.child(action.identifier).info(`web approve (${action.kind})${detail?.selection ? ' ' + detail.selection : ''}`);
    this.approveCb?.(id, detail);
    return true;
  }

  submitFeedback(id: string, text: string): boolean {
    const action = this.pending.get(id);
    if (!action) return false;
    this.pending.delete(id);
    logger.child(action.identifier).info(`web feedback (${action.kind})`);
    this.feedbackCb?.(id, text);
    return true;
  }

  /** Clear pending/diffs for a finished issue. */
  clearIssue(identifier: string): void {
    for (const [pid, p] of this.pending) if (p.identifier === identifier) this.pending.delete(pid);
    this.diffs.delete(identifier);
  }
}

function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false });
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

function kindLabel(kind: string): string {
  return (
    {
      plan: 'Plan review / choose direction',
      fix_plan: '🔧 Fix plan review',
      review: 'Self-review',
      pr_plan: 'PR fix plan review',
      question: 'Answer question',
    }[kind] ?? kind
  );
}
