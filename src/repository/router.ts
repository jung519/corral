/** Routes an issue's repoKey → the repository adapter that owns it. Replaces
 * upstream's RepositoryRegistry (a key→client map). */
import type { RepositoryAdapter } from '../core/types.js';

export class RepositoryRouter {
  constructor(private readonly repos: RepositoryAdapter[]) {}

  all(): RepositoryAdapter[] {
    return this.repos;
  }

  byKey(key: string): RepositoryAdapter | undefined {
    return this.repos.find((r) => r.key === key);
  }

  /** Resolve by key, falling back to the first repository (single-repo setups). */
  forKey(key: string | undefined): RepositoryAdapter | undefined {
    return (key ? this.byKey(key) : undefined) ?? this.repos[0];
  }
}
