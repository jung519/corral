/**
 * Accumulates cost/tokens per issue across dispatches and persists to disk so a
 * restart doesn't lose the running total. On merge the orchestrator posts a cost
 * summary comment to the tracker.
 *
 * Lifted from upstream. Adaptations: state dir → `.corral-state` (injectable), and
 * the summary comment is built from the configured language (profile Translator)
 * instead of hardcoded Korean.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MessageKey } from '../profile/i18n.js';
import { DEFAULT_STATE_DIR } from './issue-state.js';
import { logger } from './logger.js';

export interface CostEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  dispatches: number;
}

type Translate = (key: MessageKey) => string;

export class CostTracker {
  private byIssue = new Map<string, CostEntry>();
  private readonly stateDir: string;
  private readonly file: string;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    this.stateDir = stateDir;
    this.file = resolve(stateDir, 'costs.json');
    this.load();
  }

  add(identifier: string, run: { costUsd: number; inputTokens: number; outputTokens: number }): void {
    const cur = this.byIssue.get(identifier) ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      dispatches: 0,
    };
    cur.costUsd += run.costUsd;
    cur.inputTokens += run.inputTokens;
    cur.outputTokens += run.outputTokens;
    cur.dispatches += 1;
    this.byIssue.set(identifier, cur);
    this.persist();
  }

  get(identifier: string): CostEntry | undefined {
    return this.byIssue.get(identifier);
  }

  /** Cost comment posted when the issue is completed, in the configured language. */
  formatComment(identifier: string, t: Translate): string {
    const heading = `## 💰 ${t('cost.summaryHeading')}`;
    const e = this.byIssue.get(identifier);
    if (!e) return `${heading}\n${t('cost.none')}`;
    return [
      heading,
      `- ${t('cost.total')}: **$${e.costUsd.toFixed(4)}**`,
      `- ${t('cost.dispatches')}: ${e.dispatches}`,
      `- ${t('cost.tokens')}: ${e.inputTokens.toLocaleString()} / ${e.outputTokens.toLocaleString()}`,
    ].join('\n');
  }

  clear(identifier: string): void {
    this.byIssue.delete(identifier);
    this.persist();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, CostEntry>;
      this.byIssue = new Map(Object.entries(raw));
    } catch {
      /* no prior state */
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byIssue), null, 2));
    } catch (err) {
      logger.warn('cost persist failed', String(err));
    }
  }
}
