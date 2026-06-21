import { describe, expect, it } from 'vitest';
import { workerImageTag } from './builder.js';

describe('workerImageTag', () => {
  it('namespaces the hash under the corral-worker repo', () => {
    expect(workerImageTag('abc123def456')).toBe('corral-worker:abc123def456');
  });
});
