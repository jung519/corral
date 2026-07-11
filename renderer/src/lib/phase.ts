/** Phase → progress-stage + color mapping for the dashboard (see docs/ui-ux.md §5). */

/** i18n keys for the 6 progress stages shown in the issue PhaseBar. */
export const STAGE_KEYS = ['phase.plan', 'phase.approve', 'phase.implement', 'phase.review', 'phase.pr', 'phase.done'];

/** Which stage (0..5) the orchestrator phase currently sits at. */
export function stageIndex(phase: string): number {
  switch (phase) {
    case 'initial':
    case 'plan_reviewing':
      return 0;
    case 'plan_sent':
    case 'pr_plan_sent':
    case 'question_sent':
      return 1;
    case 'implementing':
    case 'review_fixing':
    case 'pr_fixing':
      return 2;
    case 'reviewing':
    case 'review_sent':
      return 3;
    case 'pr_open':
      return 4;
    case 'done':
      return 5;
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
const WAITING_PHASES = new Set(['plan_sent', 'pr_plan_sent', 'question_sent', 'review_sent', 'pr_open']);

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
export function phaseLabelKey(phase: string): string {
  if (phase === 'auth_error_waiting') return 'phase.error';
  return STAGE_KEYS[stageIndex(phase)] ?? 'phase.plan';
}

/** i18n key for the waiting badge — phase-specific so it says WHAT is awaited (a plan
 *  approval vs a PR merge), not a generic "waiting" that reads like the run is stuck. */
export function waitingLabelKey(phase: string): string {
  switch (phase) {
    case 'plan_sent':
    case 'pr_plan_sent':
      return 'wait.planApproval';
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
