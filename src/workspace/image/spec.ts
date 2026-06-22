/**
 * Auto worker image — the structured spec the agent fills in, and the prompt that
 * asks for it. Corral renders the actual Dockerfile from this spec (see
 * dockerfile.ts), guaranteeing the Claude CLI + non-root worker regardless of what
 * the agent returns. Keeping the agent to a constrained spec (not a free-form
 * Dockerfile) bounds the blast radius and keeps the non-negotiables ours.
 */
import { z } from 'zod';
import type { CollectedManifest } from './manifest.js';

/** Bump when the rendered Dockerfile's guaranteed layer changes — it's folded into
 * the image cache hash so existing images rebuild on a template change. */
export const WORKER_IMAGE_TEMPLATE_VERSION = '2';

export const WorkerImageSpecSchema = z.object({
  /** Debian/Ubuntu-based base image (apt available), e.g. "node:24-bookworm-slim". */
  base_image: z.string().min(1),
  /** apt package names to install (names only — no versions or flags). */
  system_packages: z.array(z.string()).default([]),
  /** Toolchain setup commands rendered as RUN lines (e.g. "corepack enable").
   *  NOT project dependency installs (those happen at clone time). */
  setup_commands: z.array(z.string()).default([]),
  /** Why these choices — shown in the approval UI; not rendered into the image. */
  rationale: z.string().default(''),
});

export type WorkerImageSpec = z.infer<typeof WorkerImageSpecSchema>;

/** Prompt asking the agent to emit a WorkerImageSpec (JSON) from the repo manifests. */
export function workerImagePrompt(manifests: CollectedManifest[]): string {
  const files = manifests.map((m) => `### ${m.path}\n\`\`\`\n${m.content}\n\`\`\``).join('\n\n');
  return [
    'You are configuring a Docker worker image for an automated coding agent.',
    'Below are the manifest files of one or more repositories that will be cloned side by',
    'side into the image. Produce a JSON spec describing the toolchain needed to BUILD,',
    'LINT, and TEST these repos.',
    '',
    'Rules:',
    '- base_image: ONE Debian/Ubuntu-based image (apt must be available) matching the',
    '  primary runtime, e.g. "node:24-bookworm-slim", "python:3.12-slim-bookworm",',
    '  "ghcr.io/cirruslabs/flutter:stable". If repos need several runtimes, pick the',
    '  heaviest base and add the others via setup_commands.',
    '- system_packages: apt package names only (no versions, no flags).',
    '- setup_commands: shell commands (one per line) to install language toolchains or',
    '  package managers the base lacks (e.g. "corepack enable", "pip install poetry").',
    '  Do NOT install project dependencies (done at clone time). Do NOT install the',
    '  Claude CLI, create users, or set WORKDIR — the harness adds those.',
    '- Keep it minimal; prefer official images.',
    '',
    'Output ONLY the JSON spec.',
    '',
    files,
  ].join('\n');
}
