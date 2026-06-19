/**
 * Agent scratch paths inside the workspace — the orchestrator ↔ agent handoff
 * files. Single source of truth so the prompt builder, orchestrator, and review
 * pipeline agree. (Upstream used `.symphony/`; Corral uses `.corral/`.)
 */
export const SCRATCH_DIR = '.corral';

export const SCRATCH = {
  /** Vetted plan + options the agent writes for human approval. */
  pendingPlan: `${SCRATCH_DIR}/pending_plan.md`,
  /** Consolidated self-review for human approval. */
  pendingReview: `${SCRATCH_DIR}/pending_review.md`,
  /** Previous cycle's consolidated review — input for incremental re-review. */
  prevReview: `${SCRATCH_DIR}/prev_review.md`,
  /** Deterministic static-gate result (lint/typecheck). */
  staticQa: `${SCRATCH_DIR}/static_qa.json`,
  /** Semgrep findings. */
  semgrep: `${SCRATCH_DIR}/semgrep.json`,
  /** Directory where issue attachments are materialized. */
  attachmentsDir: `${SCRATCH_DIR}/attachments`,
  /** Nth parallel review round output. */
  reviewRound: (n: number): string => `${SCRATCH_DIR}/review_round_${n}.md`,
  /** Nth parallel plan-critique output. */
  planCritique: (n: number): string => `${SCRATCH_DIR}/plan_critique_${n}.md`,
} as const;

/** Where the rendered workflow guide is written in the workspace. */
export const WORKFLOW_FILE = `${SCRATCH_DIR}/WORKFLOW.md`;
