/** Notion tracker — reference adapter. S1 stub: constructs from config; external
 * calls are lifted in S2. */
import type { TrackerConfig } from '../config/schema.js';
import { notImplemented } from '../core/not-implemented.js';
import type { BotIdentity, Issue, IssueState, TrackerAdapter, TrackerComment } from '../core/types.js';

export interface TrackerCtx {
  /** Resolved API token (from the CredentialStore). */
  token: string;
}

type NotionConfig = Extract<TrackerConfig, { kind: 'notion' }>;

export class NotionTracker implements TrackerAdapter {
  readonly kind = 'notion';
  constructor(
    private readonly config: NotionConfig,
    private readonly ctx: TrackerCtx,
  ) {}

  fetchCandidateIssues(): Promise<Issue[]> {
    return notImplemented('notion.fetchCandidateIssues');
  }
  fetchIssueByIdentifier(): Promise<Issue | null> {
    return notImplemented('notion.fetchIssueByIdentifier');
  }
  transitionIssue(_issue: Issue, _to: IssueState): Promise<void> {
    return notImplemented('notion.transitionIssue');
  }
  createComment(): Promise<void> {
    return notImplemented('notion.createComment');
  }
  fetchComments(): Promise<TrackerComment[]> {
    return notImplemented('notion.fetchComments');
  }
  getBotIdentity(): Promise<BotIdentity> {
    return notImplemented('notion.getBotIdentity');
  }
}
