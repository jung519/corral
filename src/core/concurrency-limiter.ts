/**
 * Caps the number of globally active issues (= workspaces). An issue is "active"
 * from first dispatch until it reaches a terminal state / its PR merges.
 *
 * Lifted from upstream — pure, no external dependencies.
 */
export class ConcurrencyLimiter {
  private readonly active = new Set<string>();

  constructor(private readonly max: number) {}

  /** Reserve a slot for an issue. Returns false if at capacity (and not already active). */
  tryAcquire(identifier: string): boolean {
    if (this.active.has(identifier)) return true;
    if (this.active.size >= this.max) return false;
    this.active.add(identifier);
    return true;
  }

  release(identifier: string): void {
    this.active.delete(identifier);
  }

  has(identifier: string): boolean {
    return this.active.has(identifier);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get capacity(): number {
    return this.max;
  }

  /** Seed the active set during restart recovery. */
  seed(identifiers: Iterable<string>): void {
    for (const id of identifiers) this.active.add(id);
  }
}
