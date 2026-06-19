/** Routes an issue's repoKey → the repository adapter that owns it. Replaces
 * upstream's RepositoryRegistry (a key→client map). */
import type { Issue, RepositoryAdapter } from '../core/types.js';

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

  /** Resolve the repository that owns an issue (by its repoKey). Throws if none. */
  resolve(issue: Issue): RepositoryAdapter {
    const repo = this.forKey(issue.repoKey);
    if (!repo) throw new Error(`no repository configured for issue ${issue.identifier} (repoKey=${issue.repoKey})`);
    return repo;
  }
}
