/**
 * Heuristic worker-image detection — maps repo manifests to a WorkerImageSpec with
 * pure rules (no docker, no agent), so common stacks resolve deterministically and
 * testably. `confident` is false when no known language manifest is found; the
 * caller then falls back to the agent for an unfamiliar stack (hybrid).
 *
 * The guaranteed runtime layer (git, Node, the Claude CLI, a non-root worker) is
 * added by the Dockerfile renderer — so a Flutter/Python base is fine even though
 * the Claude CLI needs Node; the renderer installs Node on top.
 */
import type { CollectedManifest } from './manifest.js';
import type { WorkerImageSpec } from './spec.js';

export interface DetectResult {
  spec: WorkerImageSpec;
  /** True if at least one known language manifest was recognized. */
  confident: boolean;
  /** Runtimes detected (for the rationale / approval UI). */
  runtimes: string[];
}

const has = (m: CollectedManifest[], file: string): boolean => m.some((x) => x.path.endsWith(`/${file}`));

export function detectWorkerImage(manifests: CollectedManifest[]): DetectResult {
  const node = has(manifests, 'package.json');
  const flutter = has(manifests, 'pubspec.yaml');
  const python = has(manifests, 'pyproject.toml') || has(manifests, 'requirements.txt') || has(manifests, 'Pipfile');
  const go = has(manifests, 'go.mod');
  const rust = has(manifests, 'Cargo.toml');
  const ruby = has(manifests, 'Gemfile');

  const runtimes: string[] = [];
  if (node) runtimes.push('node');
  if (flutter) runtimes.push('flutter');
  if (python) runtimes.push('python');
  if (go) runtimes.push('go');
  if (rust) runtimes.push('rust');
  if (ruby) runtimes.push('ruby');

  const system_packages: string[] = [];
  const setup_commands: string[] = [];

  // Node package manager: pnpm/yarn ship via corepack; npm is built in.
  if (node && (has(manifests, 'pnpm-lock.yaml') || has(manifests, 'yarn.lock'))) setup_commands.push('corepack enable');

  // Base = heaviest runtime; secondary runtimes added on top (Node always comes from
  // the guaranteed layer, so a non-Node base still gets the Claude CLI).
  let base_image: string;
  if (flutter) {
    base_image = 'ghcr.io/cirruslabs/flutter:stable';
    if (python) system_packages.push('python3', 'python3-pip');
  } else if (node) {
    base_image = 'node:24-bookworm-slim';
    if (python) system_packages.push('python3', 'python3-pip');
  } else if (python) {
    base_image = 'python:3.12-slim-bookworm';
  } else if (go) {
    base_image = 'golang:1.22-bookworm';
  } else if (rust) {
    base_image = 'rust:1-slim-bookworm';
  } else if (ruby) {
    base_image = 'ruby:3-slim-bookworm';
  } else {
    base_image = 'node:24-bookworm-slim'; // safe default; the guaranteed layer needs Node anyway
  }

  const rationale = runtimes.length
    ? `Detected ${runtimes.join(' + ')} from the manifests.`
    : 'No known language manifest found — defaulted to a Node base (agent fallback recommended).';

  return { spec: { base_image, system_packages, setup_commands, rationale }, confident: runtimes.length > 0, runtimes };
}
