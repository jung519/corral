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
  /** Human-readable output language for agent-authored docs (e.g. "Korean"). */
  language?: string;
  /** Path of the reference/conventions repo cloned in the workspace; undefined to skip. */
  reference_path?: string;
  /** Merged global + per-project Direction ("방향성") body; empty/undefined to skip. */
  direction?: string;
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

/**
 * Safety check for a user-written "Direction" text (§15). The agent judges ONLY the text
 * — not any code — and writes a strict JSON verdict. REJECT covers illicit/abusive intent
 * and things an AI coding agent cannot actually do; APPROVE covers legitimate direction.
 */
export function directionCheckPrompt(label: string, text: string, outPath: string, languageName = 'English'): string {
  return [
    `You are a safety reviewer. A user wrote the "direction" text below to steer an AI coding agent.`,
    `Judge ONLY this text — do NOT inspect any repository or code. Decide if it is safe and feasible to follow.`,
    `REJECT (approved=false) if it asks to: clone/replicate a specific website or product wholesale; scrape, abuse, or circumvent a commercial or unauthorized service; do anything illegal, deceptive, or against a service's terms; or something an AI coding agent genuinely cannot do (out of scope / impossible).`,
    `APPROVE (approved=true) if it is a legitimate direction about purpose, priorities, trade-offs, principles, or style.`,
    `When unsure whether it is merely opinionated vs actually harmful/impossible, APPROVE — only reject clear cases.`,
    `Write ONLY a JSON object to ${outPath} and nothing else: {"approved": true|false, "reason": "<one short sentence in ${languageName}>"}.`,
    `--- DIRECTION (${label}) ---`,
    text,
  ].join('\n');
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
