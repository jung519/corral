/**
 * Checking a task's tick against the repository.
 *
 * The tick is written by the agent. Whether the work happened is a different question, and
 * the two have come apart before: CRL-89 was a 4.35M-token turn that ended with the branch
 * created, the code written and nothing committed, reported as a clean exit. There was no
 * layer comparing what was declared against what was there.
 *
 * The workspace layout makes the comparison possible. `.corral/` sits *outside* the repo
 * clones — `git` answers "outside repository" for it — so a tick can never be part of a
 * commit. Declaration and fact live in different places:
 *
 *     ws/
 *     ├── .corral/spec/tasks.md   ← the claim, not in git
 *     └── <repo>/                 ← the fact, in git
 *
 * What is *not* checked is which files changed. `tasks.md` carries no file list (the format
 * is `- [ ] T1 — title (REQ-1) [after: T0]`); real task text mentions paths only in prose,
 * and scraping paths out of prose would make the verdict a guess — while the whole value
 * here is that it is not one.
 */

/** Commit ids per repo key, as `git rev-parse HEAD` reports them. */
export type RepoHeads = Record<string, string | null>;

export interface TaskEvidence {
  /** The task the turn was asked to do. */
  taskId: string;
  /** The agent ticked it. */
  claimed: boolean;
  /** At least one repo's HEAD moved during the turn. */
  committed: boolean;
  /** Repos whose HEAD advanced. */
  changed: string[];
  /** `key: before → after`, so a person can go and look. */
  detail: string;
}

/**
 * Compare the heads captured either side of a task turn against whether the task got ticked.
 *
 * Only one combination is reported: **ticked with nothing committed**. A task that produced
 * a commit without being ticked is the loop's "no progress" case and is already handled
 * (CRL-106); reporting it here as well would double up on the same event.
 *
 * A repo whose head could not be read on either side is left out of the comparison entirely
 * rather than counted as unchanged. Not knowing is not evidence of absence, and a verdict
 * built on a failed `git` call is exactly the false positive that would make this layer
 * untrustworthy.
 */
export function taskEvidence(taskId: string, claimed: boolean, before: RepoHeads, after: RepoHeads): TaskEvidence {
  const comparable = Object.keys(after).filter((k) => before[k] != null && after[k] != null);
  const changed = comparable.filter((k) => before[k] !== after[k]);
  const detail = comparable.map((k) => `${k}: ${short(before[k]!)} → ${short(after[k]!)}`).join(', ');
  return {
    taskId,
    claimed,
    // With nothing comparable there is no evidence either way; saying "not committed" from
    // a git that would not answer would invent a finding.
    committed: comparable.length === 0 || changed.length > 0,
    changed,
    detail: detail || 'no repository could be read',
  };
}

/** True when the task claims to be done and the repositories say otherwise. */
export function isUnbacked(e: TaskEvidence): boolean {
  return e.claimed && !e.committed;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
