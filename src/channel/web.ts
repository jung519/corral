/** Web dashboard channel — reference adapter. S1: lifecycle + callback wiring is
 * real; the approval surface (dashboard + SSE) is lifted in S2/S3. */
import { notImplemented } from '../core/not-implemented.js';
import type { ApprovalDetail, ApprovalRequest, ChannelAdapter } from '../core/types.js';

export interface WebChannelOptions {
  port: number;
}

export class WebChannel implements ChannelAdapter {
  readonly kind = 'web';
  private approveCb?: (approvalId: string, detail?: ApprovalDetail) => void;
  private feedbackCb?: (approvalId: string, text: string) => void;

  constructor(private readonly opts: WebChannelOptions) {}

  async start(): Promise<void> {
    // Dashboard server boots in S2/S3; nothing to start in the skeleton.
  }
  async stop(): Promise<void> {}

  sendApproval(_req: ApprovalRequest): Promise<string> {
    return notImplemented('web.sendApproval');
  }
  notify(): Promise<void> {
    return notImplemented('web.notify');
  }
  uploadDiff(): Promise<void> {
    return notImplemented('web.uploadDiff');
  }

  onApprove(cb: (approvalId: string, detail?: ApprovalDetail) => void): void {
    this.approveCb = cb;
  }
  onFeedback(cb: (approvalId: string, text: string) => void): void {
    this.feedbackCb = cb;
  }
}
