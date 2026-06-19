import { describe, expect, it } from 'vitest';
import type { IssueState } from '../core/types.js';
import { resolveIssueState } from './github-issues.js';

const labelToState = new Map<string, IssueState>([
  ['corral:planning', 'planning'],
  ['corral:in-progress', 'in_progress'],
  ['corral:review', 'in_review'],
]);

describe('resolveIssueState', () => {
  it('maps a closed issue to done', () => {
    expect(resolveIssueState('closed', ['corral:in-progress'], labelToState)).toBe('done');
  });

  it('maps an open issue by its first matching state label', () => {
    expect(resolveIssueState('open', ['bug', 'corral:in-progress'], labelToState)).toBe('in_progress');
  });

  it('defaults an open issue with no state label to planning', () => {
    expect(resolveIssueState('open', ['bug'], labelToState)).toBe('planning');
  });
});
