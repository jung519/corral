/** Tracker axis registry. Reference adapters register here; external adapters use
 * the same surface (the basis for `@corral/sdk` plugins, later). Notion is just one
 * option — anything with an API can be added (see github-issues.ts). */
import type { TrackerConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { TrackerAdapter } from '../core/types.js';
import { GithubIssuesTracker } from './github-issues.js';
import { NotionTracker, type TrackerCtx } from './notion.js';

export const trackers = new Registry<TrackerConfig, TrackerAdapter, TrackerCtx>('tracker');

trackers.register('notion', (config, ctx) =>
  new NotionTracker(config as Extract<TrackerConfig, { kind: 'notion' }>, ctx),
);
trackers.register('github_issues', (config, ctx) =>
  new GithubIssuesTracker(config as Extract<TrackerConfig, { kind: 'github_issues' }>, ctx),
);

export type { TrackerCtx };
