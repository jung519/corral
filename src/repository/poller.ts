/**
 * Repository poller — for each tracked PR, detects new comments (since last seen)
 * and merge events. Stateless: the orchestrator owns the tracking table and
 * advances `since` after handling events.
 *
 * Lifted from upstream. Adaptation: merge detection now calls
 * RepositoryAdapter.refreshPullRequest directly (interface method) instead of a
 * GitHub-specific `instanceof` check — keeps the poller provider-neutral.
 */
import { logger } from '../core/logger.js';
import type { PullRequest, PullRequestComment } from '../core/types.js';
import type { RepositoryRouter } from './router.js';

export interface TrackedPr {
  identifier: string;
  repoKey: string;
  prNumber: number;
  branch: string;
  /** ISO timestamp of the last comment already handled. */
  since?: string;
}

export interface RepoEvents {
  newComments: Array<{ identifier: string; comments: PullRequestComment[]; latest: string }>;
  merged: Array<{ identifier: string; pr: PullRequest }>;
}

export class RepositoryPoller {
  constructor(private readonly router: RepositoryRouter) {}

  async checkOnce(tracked: TrackedPr[]): Promise<RepoEvents> {
    const events: RepoEvents = { newComments: [], merged: [] };

    for (const t of tracked) {
      const repo = this.router.forKey(t.repoKey);
      if (!repo) continue;

      try {
        const refreshed = await repo.refreshPullRequest(t.prNumber);
        if (refreshed?.merged) {
          events.merged.push({ identifier: t.identifier, pr: refreshed });
          continue; // merged PRs need no comment handling
        }

        const pr: PullRequest = {
          number: t.prNumber,
          url: '',
          title: '',
          branch: t.branch,
          baseBranch: '',
          state: 'open',
          merged: false,
        };
        const comments = await repo.fetchPullRequestComments(pr, t.since);
        if (comments.length > 0) {
          const latest = comments.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), t.since ?? '');
          events.newComments.push({ identifier: t.identifier, comments, latest });
        }
      } catch (err) {
        logger.child(t.identifier).warn('repo poll failed', String(err));
      }
    }
    return events;
  }
}
