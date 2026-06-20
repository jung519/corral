/**
 * Renders the workflow guide (Liquid) with per-dispatch issue data, and builds the
 * short kickoff/turn prompts + orchestrator signals. The workflow guide is the
 * durable behavior contract; the prompt is the momentary instruction.
 *
 * Lifted from upstream. De-masil: the language-dependent signals (approve /
 * feedback / refine / resume) render from the configured language via the profile
 * Translator instead of hardcoded Korean; scratch paths come from core/paths.
 */
import { Liquid } from 'liquidjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCRATCH, WORKFLOW_FILE } from '../core/paths.js';
import type { Issue } from '../core/types.js';
import type { Translator } from '../profile/i18n.js';

const engine = new Liquid({ cache: true });

/** One repo cloned in the workspace, described to the agent so it can decide which
 * repo(s) the issue touches. `dir` is the subdirectory under the workspace root. */
export interface WorkflowRepo {
  key: string;
  dir: string;
  description: string;
  base_branch: string;
  /** The work branch the agent must create in this repo if it changes it. */
  branch: string;
}

export interface WorkflowContext {
  issue: Issue;
  tracker_kind: string;
  /** All repos cloned side by side; the agent commits in whichever it changes. */
  repos: WorkflowRepo[];
  /** Path of the reference/conventions repo cloned in the workspace; undefined to skip. */
  reference_path?: string;
}

let templateSource: string | null = null;
function loadTemplate(path: string): string {
  if (templateSource === null) templateSource = readFileSync(resolve(path), 'utf8');
  return templateSource;
}

/** Render the workflow guide for a dispatch. The template path defaults to
 * CORRAL_WORKFLOW_PATH (set when the core is spawned with a non-repo cwd, e.g. by
 * the desktop app) or 'WORKFLOW.md' relative to cwd for standalone/headless use. */
export async function renderWorkflow(
  ctx: WorkflowContext,
  templatePath = process.env.CORRAL_WORKFLOW_PATH ?? 'WORKFLOW.md',
): Promise<string> {
  return engine.parseAndRender(loadTemplate(templatePath), ctx as unknown as Record<string, unknown>);
}

/** The prompt that kicks off a fresh agent session. */
export function kickoffPrompt(issue: Issue, workflowFile: string = WORKFLOW_FILE): string {
  return [
    `You are Corral's worker for issue ${issue.identifier}.`,
    `Follow ${workflowFile} exactly. Determine the correct branch and act.`,
    `This is a fresh session with no prior memory.`,
  ].join(' ');
}

/** The message for a continued session (approval / feedback / answer). */
export function turnPrompt(message: string): string {
  return message;
}

/** Language-independent operational instructions sent to the agent. */
export const PROMPTS = {
  consolidateReview: `Please consolidate the review rounds into ${SCRATCH.pendingReview}.`,
  consolidatePlan: `Please consolidate the plan critiques into the final vetted plan (${SCRATCH.pendingPlan}).`,
  applyReviewFixes: 'Please apply the BLOCKER and SUGGESTION fixes from the review and commit.',
} as const;

export interface Signals {
  /** Plan/review approved — proceed. */
  approve: string;
  /** Revision requested with feedback text. */
  feedback(text: string): string;
  /** Human "review further" — a focused critique on a specific concern. */
  refinePlan(focus: string): string;
  /** Resume after a restart interrupted an unattended run. */
  resume: string;
}

/** Build the language-dependent signals from the configured language. */
export function buildSignals(t: Translator): Signals {
  return {
    approve: `✅ ${t('signal.approved')}`,
    feedback: (text) => `⚠️ ${t('signal.feedback')}: ${text}`,
    refinePlan: (focus) => `🔍 ${t('signal.requestMoreReview')}: ${focus}`,
    resume: t('signal.resume'),
  };
}
