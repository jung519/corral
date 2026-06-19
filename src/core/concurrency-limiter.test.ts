import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './concurrency-limiter.js';

describe('ConcurrencyLimiter', () => {
  it('acquires up to capacity, then refuses new ids', () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
    expect(limiter.activeCount).toBe(2);
  });

  it('is idempotent for an already-active id', () => {
    const limiter = new ConcurrencyLimiter(1);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.activeCount).toBe(1);
  });

  it('frees a slot on release', () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.tryAcquire('a');
    expect(limiter.tryAcquire('b')).toBe(false);
    limiter.release('a');
    expect(limiter.tryAcquire('b')).toBe(true);
  });

  it('seeds active ids for restart recovery', () => {
    const limiter = new ConcurrencyLimiter(3);
    limiter.seed(['x', 'y']);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.has('x')).toBe(true);
  });
});
