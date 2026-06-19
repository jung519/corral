import { describe, expect, it } from 'vitest';
import type { Issue, TrackerAdapter } from '../core/types.js';
import { TrackerPoller } from './poller.js';

const issue = (id: string): Issue => ({
  identifier: id,
  internalId: id,
  title: id,
  description: '',
  state: 'planning',
  labels: [],
  blockedBy: [],
  attachments: [],
});

function fakeTracker(issues: Issue[]): TrackerAdapter {
  return {
    kind: 'fake',
    async fetchCandidateIssues() {
      return issues;
    },
  } as unknown as TrackerAdapter;
}

describe('TrackerPoller', () => {
  it('pollOnce returns the tracker candidates', async () => {
    const poller = new TrackerPoller(fakeTracker([issue('ISS-1'), issue('ISS-2')]), 1000, async () => {});
    const result = await poller.pollOnce();
    expect(result.map((i) => i.identifier)).toEqual(['ISS-1', 'ISS-2']);
  });
});
