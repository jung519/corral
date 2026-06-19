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
