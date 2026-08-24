/**
 * The third layer of verification.
 *
 * Two layers already exist. The static gate runs real commands and a non-zero exit is a
 * BLOCKER — the plan doc puts it first precisely because it is *"an objective fact an LLM
 * reviewer cannot rationalise away"*. Above it sits the LLM review, which is judgement.
 *
 * The acceptance criteria belong with the first kind, not the second. Whether the code
 * satisfies `REQ-3` is a fact, and the plan and the diff are both right there. So the count
 * arrives as its own field and the decision is made here, in code — not by asking the model
 * to fold unmet criteria into its BLOCKER tally and trusting the arithmetic. A model that
 * calls an unmet criterion met, or simply forgets to count it, would be invisible.
 *
 * (Measured once — in CRL-99 the reviewer did raise the unmet criterion to BLOCKER on its
 * own. Once is not a guarantee, and enforcing it costs less than confirming it.)
 */

/** Counts written by the review consolidation into `.corral/review_status.json`. */
export interface ReviewStatus {
  blocker: number;
  suggestion: number;
  nit: number;
  /**
   * How the plan's `REQ-n` criteria came out.
   *
   * Absent means the plan had none — a hand-written plan, or one made before criteria were
   * required. That is different from `{ total: 0, met: 0 }`, which would claim the plan
   * defined zero criteria, and it is why this is optional rather than defaulted.
   */
  criteria?: { total: number; met: number };
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Parse the file the agent wrote.
 *
 * Defensive on purpose: this is model-authored JSON. Anything malformed in `criteria` —
 * non-numeric, negative, or more met than exist — is dropped rather than guessed at, which
 * lands on the pre-existing behaviour instead of inventing a verdict from nonsense.
 */
export function parseReviewStatus(raw: string | null): ReviewStatus | null {
  if (!raw) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const status: ReviewStatus = { blocker: count(p.blocker), suggestion: count(p.suggestion), nit: count(p.nit) };
  const c = p.criteria;
  if (c && typeof c === 'object') {
    const t = Number((c as Record<string, unknown>).total);
    const m = Number((c as Record<string, unknown>).met);
    // Checked before clamping, not after: clamping a negative pair to zero would turn
    // nonsense into the claim "this plan defined zero criteria", which is a real statement
    // and not the one the file made.
    if (Number.isInteger(t) && Number.isInteger(m) && t >= 0 && m >= 0 && m <= t) {
      status.criteria = { total: t, met: m };
    }
  }
  return status;
}

/** Criteria the code does not satisfy. Zero when the plan had none. */
export function unmetCriteria(status: ReviewStatus | null): number {
  if (!status?.criteria) return 0;
  return status.criteria.total - status.criteria.met;
}

/**
 * Whether the branch may go straight to a PR without a human looking.
 *
 * An unmet criterion blocks it on its own. Everything else about the review can be quiet —
 * no blockers, no suggestions — and a requirement the plan committed to is still missing;
 * shipping that unseen is exactly what writing the criteria down was meant to prevent.
 */
export function isReviewClean(status: ReviewStatus | null): boolean {
  if (!status) return true; // No status file at all — unchanged from before.
  return status.blocker + status.suggestion === 0 && unmetCriteria(status) === 0;
}

/** Findings the auto-fix loop should try to resolve, unmet criteria included. */
export function fixableCount(status: ReviewStatus | null): number {
  if (!status) return 0;
  return status.blocker + status.suggestion + unmetCriteria(status);
}
