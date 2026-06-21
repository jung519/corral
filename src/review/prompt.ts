/**
 * Review-round + plan-critique prompts. Each round is an INDEPENDENT fresh session
 * (no shared memory) so perspectives stay diverse; the validator merges them later.
 *
 * Lifted from upstream. De-masil: output language, the "no issues" / resolved /
 * unresolved phrasing, and the severity calibration examples all come from the
 * configured profile (language + stack) instead of hardcoded Korean + masil's stack.
 * The reference repo is generic (no design_system/masil_project subpaths).
 */
import { SCRATCH } from '../core/paths.js';
import type { Issue } from '../core/types.js';
import type { ResolvedProfile } from '../profile/index.js';

/**
 * Plan vetting — an independent, skeptical critic reviews the DRAFT plan BEFORE any
 * code is written, so gaps are caught in planning instead of leaking to code review.
 */
export function planCritiquePrompt(
  issue: Issue,
  round: number,
  profile: ResolvedProfile,
  referencePath?: string,
  focus?: string,
): string {
  const out = SCRATCH.planCritique(round);
  const lines = [
    `You are an independent, SKEPTICAL plan reviewer for issue ${issue.identifier} (round ${round}).`,
    `Read the DRAFT plan at \`${SCRATCH.pendingPlan}\` and the issue. Critique it BEFORE any code is written.`,
    `Inspect the ACTUAL repositories (each subdirectory of the workspace is a repo) to verify the plan's assumptions — do not trust the plan's claims.`,
    `Hunt for:`,
    `- Underspecified / ambiguous steps; missing edge cases, failure modes, concurrency, data migration.`,
    `- WRONG assumptions about the schema / API / existing code (cite the real file:line that contradicts the plan).`,
    `- Anything that would BREAK existing behavior.`,
    `- Acceptance criteria that are missing, vague, or not testable.`,
    `- A simpler or safer approach the plan overlooked.`,
  ];
  if (focus) {
    lines.push(`The human asked you to focus this review on: "${focus}". Prioritize that, but still report other serious gaps.`);
  }
  if (referencePath) {
    lines.push(`Check the plan against the conventions in the reference repo at ${referencePath}.`);
  }
  lines.push(
    `Classify each finding as BLOCKER / SUGGESTION / NIT with a rationale and (where relevant) a file:line.`,
    `Write your critique as Markdown to ${out}. Do NOT modify any code or the plan file.`,
    `Write in ${profile.languageName}; keep severity labels, file paths, and code identifiers in English.`,
    `If the plan is genuinely sound after probing, write "${profile.t('review.noIssues')}" to ${out}.`,
  );
  return lines.join(' ');
}

/** A changed repo clone to scope a review diff to: subdirectory + its base commit. */
export interface ReviewTarget {
  dir: string;
  base: string;
}

/** Per-repo diff commands for the review prompt (multi-repo aware). */
function diffInstruction(targets: ReviewTarget[]): string {
  const cmds = targets.map((t) => `\`git -C ${t.dir} diff ${t.base}..HEAD\``);
  if (cmds.length === 1) return `Review ONLY the changes in this branch: run ${cmds[0]}.`;
  return (
    `Review ONLY this issue's changes, which span ${targets.length} repos ` +
    `(${targets.map((t) => `\`${t.dir}/\``).join(', ')}). Inspect each repo's diff: ${cmds.join(' ; ')}.`
  );
}

export function reviewRoundPrompt(
  issue: Issue,
  round: number,
  targets: ReviewTarget[],
  profile: ResolvedProfile,
  referencePath?: string,
): string {
  const out = SCRATCH.reviewRound(round);
  const examples = profile.stack.calibrationExamples.map((e) => `  - ${e}`).join('\n');
  const lines = [
    `You are an independent, SKEPTICAL code reviewer for issue ${issue.identifier} (round ${round}).`,
    diffInstruction(targets),
    `Look for correctness bugs, security issues, missing edge cases, and error handling gaps.`,
    `Mindset: a default reviewer is a POOR QA — it finds a real problem and waves it through as "minor", and never probes edge cases. Do the opposite:`,
    `- Do NOT be lenient. Do NOT shrink or rationalize a problem you found.`,
    `- Actively hunt edge cases: null/undefined, empty list, concurrent calls, error/throw paths, auth/permission boundaries, off-by-one, unawaited promises.`,
    `- If a change can break existing behavior, that is a BLOCKER even if the new feature "works".`,
    `BEFORE judging, read \`${SCRATCH.staticQa}\` if it exists. It holds static-check results (lint / typecheck / analyze) that were actually executed. These are DETERMINISTIC FACTS:`,
    `- Any command with a non-zero \`code\` is a real failure caused by this branch. Treat it as a BLOCKER and diagnose the root cause. Never dismiss it as noise.`,
    `- Then look for what static tools CANNOT catch: logic errors, wrong behavior, missing edge cases.`,
    `ALSO read \`${SCRATCH.prevReview}\` if it exists — the PREVIOUS review; the current diff includes the fix meant to address it. This is a RE-REVIEW:`,
    `- For EACH prior finding, inspect the current code and state explicitly "${profile.t('review.resolved')}" (verify the actual code) or "${profile.t('review.unresolved')}" (cite the current file:line still affected).`,
    `- Do NOT silently re-raise a previous finding as if new — tie it back with its id and the verdict.`,
    `- Then report any NEW issues the fix introduced or that were missed before.`,
    `- If \`${SCRATCH.prevReview}\` does NOT exist, this is the first review — review normally.`,
  ];
  if (referencePath) {
    lines.push(`ALSO check compliance with the conventions in the reference repo at ${referencePath}. Flag any violation.`);
  }
  lines.push(
    `Calibration — findings at this level warrant a BLOCKER (align your severity to these):\n${examples}`,
    `NIT: cosmetic only (naming, import order, a comma the linter did not flag).`,
    `REJECT (do not report, state the reason): "this could be slow" with no evidence on a cold path; a style preference the linter already allows; a "missing await" on a deliberately fire-and-forget call.`,
    `Classify each finding as BLOCKER / SUGGESTION / NIT with a file:line reference and a short rationale.`,
    `Write your findings as Markdown to ${out}. Do NOT modify any source code.`,
    `Write the findings in ${profile.languageName}; keep severity labels, file paths, and code identifiers in English.`,
    `Be concise but do not omit a real BLOCKER. If you genuinely find nothing after probing, write "${profile.t('review.noIssues')}" to ${out}.`,
  );
  return lines.join(' ');
}
