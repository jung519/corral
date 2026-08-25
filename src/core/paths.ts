/**
 * Agent scratch paths inside the workspace — the orchestrator ↔ agent handoff
 * files. Single source of truth so the prompt builder, orchestrator, and review
 * pipeline agree. (The pre-rename implementation used `.symphony/`; Corral uses `.corral/`.)
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
  /** Draft plan preserved across the consolidate dispatch (which wipes pending_plan). */
  planDraft: `${SCRATCH_DIR}/plan_draft.md`,
  /** Adaptive plan option labels (recommended first); ≤1 element → no selection UI. */
  planOptions: `${SCRATCH_DIR}/plan_options.json`,
  /** Unresolved finding counts {blocker, suggestion, nit} — drives the auto-fix loop. */
  reviewStatus: `${SCRATCH_DIR}/review_status.json`,
  /** Agent's answer to a read-only Q&A question (structured markdown, preserved verbatim). */
  qaAnswer: `${SCRATCH_DIR}/qa_answer.md`,
  /** Direction safety-check verdict: `{"approved": bool, "reason": "…"}`. */
  directionCheck: `${SCRATCH_DIR}/direction_check.json`,
  /** Agent's question to the human (when it can't proceed). */
  question: `${SCRATCH_DIR}/question.md`,
  /** PR metadata the agent writes (title/body) for the orchestrator to open the PR. */
  prMeta: `${SCRATCH_DIR}/pr_meta.json`,
  /** Base commit captured before implementation — defines the review diff scope. */
  baseCommit: `${SCRATCH_DIR}/base_commit.txt`,
  /** Nth parallel review round output. */
  reviewRound: (n: number): string => `${SCRATCH_DIR}/review_round_${n}.md`,
  /** Nth parallel plan-critique output. */
  planCritique: (n: number): string => `${SCRATCH_DIR}/plan_critique_${n}.md`,
} as const;

/**
 * The spec documents of spec-driven planning (SDD S2).
 *
 * Unlike `pending_plan.md`, these are meant to live across many dispatches: requirements
 * are written once and then read by the design turn, the task turn, the implementation, and
 * the review. That only works because a dispatch now clears exactly the outputs it declares
 * and nothing else (CRL-88) — before that, surviving a dispatch was an accident of which of
 * two hard-coded lists a file happened to be on.
 *
 * **No dispatch may declare these as its outputs.** Doing so would blank a later turn's
 * input, which is the failure CRL-88 was about; `scratch-outputs.test.ts` pins it.
 */
export const SPEC_DIR = `${SCRATCH_DIR}/spec`;

export const SPEC = {
  /** WHAT must be true — EARS criteria with REQ-n ids. */
  requirements: `${SPEC_DIR}/requirements.md`,
  /** HOW it will be built — the approach, traced back to REQ ids. */
  design: `${SPEC_DIR}/design.md`,
  /** The ordered work, as checkboxes referencing the REQ ids they serve. */
  tasks: `${SPEC_DIR}/tasks.md`,
} as const;

/** Where the rendered workflow guide is written in the workspace. */
export const WORKFLOW_FILE = `${SCRATCH_DIR}/WORKFLOW.md`;
