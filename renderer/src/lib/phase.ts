/** Phase → progress-stage + color mapping for the dashboard. */

/** i18n keys for the progress stages shown in the issue PhaseBar. */
const SINGLE_STAGES = ['phase.plan', 'phase.approve', 'phase.implement', 'phase.review', 'phase.pr', 'phase.done'];

/**
 * Spec mode splits the one approval stage into the three gates it actually is. A stage is
 * *replaced*, not appended, so `single` renders exactly what it rendered before.
 */
const SPLIT_STAGES = [
  'phase.plan',
  'kind.requirements',
  'kind.design',
  'kind.tasks',
  'phase.implement',
  'phase.review',
  'phase.pr',
  'phase.done',
];

export function stageKeys(specMode: string | undefined): string[] {
  return specMode === 'split' ? SPLIT_STAGES : SINGLE_STAGES;
}

/** Where each spec gate sits in `SPLIT_STAGES`. */
const SPEC_GATE_STAGE: Record<string, number> = { requirements: 1, design: 2, tasks: 3 };

/**
 * Which stage the orchestrator phase currently sits at, as an index into `stageKeys()`.
 *
 * `specMode` is passed rather than inferred from the phase: after the last gate is approved
 * the phase says nothing about how planning was shaped, so an inferring bar would collapse
 * from three approval stages back to one just as the long part of the run begins.
 *
 * `specStage` is what tells the three vetting passes apart. They all run under the one
 * `plan_reviewing` phase, so without it the bar cannot say which document is being worked.
 */
export function stageIndex(phase: string, specMode?: string, specStage?: string): number {
  const split = specMode === 'split';
  // Everything after the approval stage(s) shifts right by the two extra gates.
  const after = (n: number) => n + (split ? 2 : 0);
  switch (phase) {
    case 'initial':
      return 0;
    // Vetting sits on the gate it is working toward. In split mode this phase comes round
    // once per gate, so sending it to 0 walked the bar backwards — requirements (1) →
    // vetting the design (0) → design (2) — and a bar that goes back reads as a run that
    // went back to planning (CRL-128). With no stage it is the single planning stage.
    case 'plan_reviewing':
      return split ? (SPEC_GATE_STAGE[specStage ?? ''] ?? 0) : 0;
    case 'requirements_sent':
      return 1;
    case 'design_sent':
      return split ? 2 : 1;
    case 'tasks_sent':
      return split ? 3 : 1;
    case 'plan_sent':
    case 'pr_plan_sent':
    case 'question_sent':
      return 1;
    case 'implementing':
    case 'review_fixing':
    case 'pr_fixing':
      return after(2);
    case 'reviewing':
    case 'review_sent':
      return after(3);
    case 'pr_open':
      return after(4);
    case 'done':
      return after(5);
    default:
      return 0;
  }
}

/** Phases where the AI is NOT actively working — waiting on a human, an external
 * event (PR), an error, or finished. Everything else means an agent run is in flight. */
const IDLE_PHASES = new Set([
  'plan_sent',
  'pr_plan_sent',
  'question_sent',
  'requirements_sent',
  'design_sent',
  'tasks_sent',
  'review_sent',
  'pr_open',
  'auth_error_waiting',
  'done',
]);

/** True when the agent is actively working the issue (show a spinner). */
export function isWorking(phase: string): boolean {
  return !IDLE_PHASES.has(phase);
}

/** Phases that are in-flight but paused on a human action or an external event (PR
 * merge) — not the agent working, but the issue is still actively progressing. */
const WAITING_PHASES = new Set([
  'plan_sent',
  'pr_plan_sent',
  'question_sent',
  'requirements_sent',
  'design_sent',
  'tasks_sent',
  'review_sent',
  'pr_open',
]);

export type PhaseActivity = 'working' | 'waiting' | 'error' | 'done' | 'idle';

/** What the current stage is doing — drives the in-progress indicator on the PhaseBar.
 * `working` = agent running, `waiting` = awaiting a human/external action (still in
 * flight), `error` = needs re-auth, `done` = finished. */
export function phaseActivity(phase: string): PhaseActivity {
  if (phase === 'done') return 'done';
  if (phase === 'auth_error_waiting') return 'error';
  if (WAITING_PHASES.has(phase)) return 'waiting';
  return isWorking(phase) ? 'working' : 'idle';
}

/** Badge text color for a phase (CSS var). */
export function phaseColor(phase: string): string {
  if (phase === 'done' || phase === 'pr_open') return 'var(--green)';
  if (phase === 'auth_error_waiting') return 'var(--red)';
  if (phase.endsWith('_sent')) return 'var(--amber)'; // action needed
  return 'var(--accent-text)';
}

/** i18n key for the short phase badge label (the active stage, or error). */
export function phaseLabelKey(phase: string, specMode?: string, specStage?: string): string {
  if (phase === 'auth_error_waiting') return 'phase.error';
  return stageKeys(specMode)[stageIndex(phase, specMode, specStage)] ?? 'phase.plan';
}

/** i18n key for the waiting badge — phase-specific so it says WHAT is awaited (a plan
 *  approval vs a PR merge), not a generic "waiting" that reads like the run is stuck. */
export function waitingLabelKey(phase: string): string {
  switch (phase) {
    case 'plan_sent':
    case 'pr_plan_sent':
      return 'wait.planApproval';
    // Named separately rather than folded into the plan label: with three gates in a row,
    // "awaiting plan approval" three times running tells the reader nothing about where
    // they are.
    case 'requirements_sent':
      return 'wait.requirementsApproval';
    case 'design_sent':
      return 'wait.designApproval';
    case 'tasks_sent':
      return 'wait.tasksApproval';
    case 'review_sent':
      return 'wait.reviewApproval';
    case 'question_sent':
      return 'wait.answer';
    case 'pr_open':
      return 'wait.prMerge';
    default:
      return 'dash.waiting';
  }
}
