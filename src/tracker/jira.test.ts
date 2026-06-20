import { describe, expect, it } from 'vitest';
import type { IssueState } from '../core/types.js';
import { flattenAdf, resolveJiraState } from './jira.js';

const nameToState = new Map<string, IssueState>([
  ['To Do', 'planning'],
  ['In Progress', 'in_progress'],
  ['In Review', 'in_review'],
]);

describe('resolveJiraState', () => {
  it('maps the done status category to done', () => {
    expect(resolveJiraState('done', 'Closed', nameToState)).toBe('done');
  });
  it('maps an active status by name', () => {
    expect(resolveJiraState('indeterminate', 'In Progress', nameToState)).toBe('in_progress');
  });
  it('defaults unmapped statuses to planning', () => {
    expect(resolveJiraState('new', 'Backlog', nameToState)).toBe('planning');
  });
});

describe('flattenAdf', () => {
  it('flattens a paragraph doc to text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }],
    };
    expect(flattenAdf(doc).trim()).toBe('hello world');
  });
  it('returns empty for missing/odd input', () => {
    expect(flattenAdf(undefined)).toBe('');
    expect(flattenAdf({ type: 'rule' })).toBe('');
  });
});
