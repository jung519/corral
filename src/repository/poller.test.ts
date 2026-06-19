import { describe, expect, it } from 'vitest';
import type { PullRequest, PullRequestComment, RepositoryAdapter } from '../core/types.js';
import { RepositoryPoller } from './poller.js';
import { RepositoryRouter } from './router.js';

function fakeRepo(opts: {
  key: string;
  refreshed?: PullRequest | null;
  comments?: PullRequestComment[];
}): RepositoryAdapter {
  return {
    key: opts.key,
    async refreshPullRequest() {
      return opts.refreshed ?? null;
    },
    async fetchPullRequestComments() {
      return opts.comments ?? [];
    },
  } as unknown as RepositoryAdapter;
}

const pr = (merged: boolean): PullRequest => ({
  number: 7,
  url: 'u',
  title: 't',
  branch: 'b',
  baseBranch: 'main',
  state: merged ? 'merged' : 'open',
  merged,
});

describe('RepositoryPoller', () => {
  it('reports a merged PR and skips its comments', async () => {
    const router = new RepositoryRouter([fakeRepo({ key: 'main', refreshed: pr(true) })]);
    const events = await new RepositoryPoller(router).checkOnce([
      { identifier: 'ISS-1', repoKey: 'main', prNumber: 7, branch: 'b' },
    ]);
    expect(events.merged).toHaveLength(1);
    expect(events.merged[0]?.identifier).toBe('ISS-1');
    expect(events.newComments).toHaveLength(0);
  });

  it('collects new comments with the latest timestamp', async () => {
    const comments: PullRequestComment[] = [
      { id: '1', author: 'a', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
      { id: '2', author: 'b', body: 'yo', createdAt: '2026-01-02T00:00:00Z' },
    ];
    const router = new RepositoryRouter([fakeRepo({ key: 'main', refreshed: pr(false), comments })]);
    const events = await new RepositoryPoller(router).checkOnce([
      { identifier: 'ISS-2', repoKey: 'main', prNumber: 7, branch: 'b' },
    ]);
    expect(events.newComments).toHaveLength(1);
    expect(events.newComments[0]?.latest).toBe('2026-01-02T00:00:00Z');
  });

  it('skips tracked PRs with no matching repo', async () => {
    const events = await new RepositoryPoller(new RepositoryRouter([])).checkOnce([
      { identifier: 'ISS-3', repoKey: 'gone', prNumber: 1, branch: 'b' },
    ]);
    expect(events.merged).toHaveLength(0);
    expect(events.newComments).toHaveLength(0);
  });
});
