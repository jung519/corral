/**
 * What the commit-based check cannot see.
 *
 * After an implementation turn the orchestrator asks each repo for `git diff <base>..HEAD`
 * and, finding nothing, reports that no changes were detected. That is true and useless:
 * `HEAD` cannot show a work tree. An agent that edited every file and skipped the commit
 * looks exactly like an agent that did nothing, and the operator reads "no changes" and
 * presses restart — throwing away work that was sitting there intact (CRL-91).
 *
 * It happened for real: a 4.35M-token implementation turn ended with the branch created,
 * the schema edited and a 192-line regression test written, and the run was reported as
 * having produced nothing. Committing by hand afterwards yielded 2 files / +219.
 *
 * So before saying "nothing happened", look at the work tree and say which it is. The two
 * cases need different things from the operator — one needs a commit, the other needs the
 * implementation to run again — and today they get the same sentence.
 */
import type { WorkspaceHandle, WorkspaceIO } from './types.js';

export interface UncommittedRepo {
  /** Repo key (its subdirectory in the workspace). */
  key: string;
  /** Paths as git reports them, relative to the repo. */
  files: string[];
}

/**
 * Uncommitted paths in one repo, via `git status --porcelain`.
 *
 * Returns an empty list when the repo is clean **and** when git cannot answer — a missing
 * clone, a broken repo, a docker exec that failed. This runs only to make a stuck message
 * more useful, so it must never be the thing that breaks the run.
 */
export async function uncommittedIn(
  io: WorkspaceIO,
  handle: WorkspaceHandle,
  key: string,
): Promise<string[]> {
  let out: { stdout: string; code: number };
  try {
    out = await io.exec(handle, `git -C ${key} status --porcelain`);
  } catch {
    return [];
  }
  if (out.code !== 0) return [];
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    // Porcelain v1 is `XY <path>`; the status letters are what we drop, not the path.
    .filter((l) => l.length > 0)
    .map((l) => l.slice(2).trim())
    .filter((p) => p.length > 0);
}

/** The same over several repos, keeping only those that actually have something. */
export async function uncommittedAcross(
  io: WorkspaceIO,
  handle: WorkspaceHandle,
  keys: readonly string[],
): Promise<UncommittedRepo[]> {
  const found: UncommittedRepo[] = [];
  for (const key of keys) {
    const files = await uncommittedIn(io, handle, key);
    if (files.length > 0) found.push({ key, files });
  }
  return found;
}

/** One line per repo for a stuck message: `server (3): a.ts, b.ts, …`. */
export function describeUncommitted(repos: readonly UncommittedRepo[], maxFiles = 5): string {
  return repos
    .map(({ key, files }) => {
      const shown = files.slice(0, maxFiles).join(', ');
      const rest = files.length > maxFiles ? `, +${files.length - maxFiles} more` : '';
      return `${key} (${files.length}): ${shown}${rest}`;
    })
    .join(' | ');
}
