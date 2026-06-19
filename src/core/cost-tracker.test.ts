import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranslator } from '../profile/i18n.js';
import { CostTracker } from './cost-tracker.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-cost-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CostTracker', () => {
  it('accumulates cost/tokens/dispatches across adds', () => {
    const tracker = new CostTracker(dir);
    tracker.add('ISS-1', { costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
    tracker.add('ISS-1', { costUsd: 0.02, inputTokens: 10, outputTokens: 5 });
    const e = tracker.get('ISS-1')!;
    expect(e.costUsd).toBeCloseTo(0.03);
    expect(e.inputTokens).toBe(110);
    expect(e.dispatches).toBe(2);
  });

  it('persists across instances', () => {
    new CostTracker(dir).add('ISS-2', { costUsd: 1, inputTokens: 1, outputTokens: 1 });
    expect(new CostTracker(dir).get('ISS-2')?.costUsd).toBe(1);
  });

  it('formats a comment in the configured language', () => {
    const tracker = new CostTracker(dir);
    tracker.add('ISS-3', { costUsd: 0.5, inputTokens: 1000, outputTokens: 200 });
    const ko = tracker.formatComment('ISS-3', createTranslator('ko'));
    expect(ko).toContain('총 비용');
    expect(ko).toContain('$0.5000');
    const en = tracker.formatComment('ISS-3', createTranslator('en'));
    expect(en).toContain('Total cost');
  });

  it('formats an empty summary when nothing is recorded', () => {
    const tracker = new CostTracker(dir);
    expect(tracker.formatComment('none', createTranslator('en'))).toContain('No cost recorded.');
  });
});
