/**
 * Tracker poller — every `intervalMs` fetches active issues and hands them to a
 * callback. Self-scheduling (no overlapping runs); errors are logged, not fatal.
 * Lifted from upstream.
 */
import { logger } from '../core/logger.js';
import type { Issue, TrackerAdapter } from '../core/types.js';

export type IssuesHandler = (issues: Issue[]) => Promise<void>;

export class TrackerPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly intervalMs: number,
    private readonly onIssues: IssuesHandler,
  ) {}

  start(): void {
    this.stopped = false;
    logger.info(`tracker poller started (${this.tracker.kind}, every ${this.intervalMs}ms)`);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a single poll immediately (used by one-shot polling and tests). */
  async pollOnce(): Promise<Issue[]> {
    const issues = await this.tracker.fetchCandidateIssues();
    logger.info(
      `poll: ${issues.length} candidate issue(s)`,
      issues.map((i) => `${i.identifier}[${i.state}]`),
    );
    return issues;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const issues = await this.tracker.fetchCandidateIssues();
      logger.debug(`poll: ${issues.length} candidate issue(s)`);
      await this.onIssues(issues);
    } catch (err) {
      logger.error('tracker poll failed', String(err));
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    }
  }
}
