/**
 * Collects the manifest/lockfiles that reveal a repo's toolchain, so the agent can
 * pick a base image and toolchain. Also hashes them for image caching (rebuild only
 * when a manifest changes). Pure fs + hashing — no docker, no agent.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Files that declare a project's runtime/toolchain. Order is stable for hashing. */
export const MANIFEST_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'composer.json',
  '.tool-versions',
  '.nvmrc',
  'mise.toml',
  'Dockerfile',
  'Makefile',
] as const;

export interface CollectedManifest {
  /** "<repoKey>/<file>" relative to the workspace root. */
  path: string;
  content: string;
}

/** Read present manifest files across the given repo subdirs. Each file is capped so
 * the agent prompt stays bounded. */
export async function collectManifests(
  root: string,
  repoKeys: string[],
  maxBytes = 16_000,
): Promise<CollectedManifest[]> {
  const out: CollectedManifest[] = [];
  for (const key of repoKeys) {
    for (const file of MANIFEST_FILES) {
      try {
        const content = await readFile(join(root, key, file), 'utf8');
        out.push({ path: `${key}/${file}`, content: content.length > maxBytes ? content.slice(0, maxBytes) : content });
      } catch {
        /* not present in this repo */
      }
    }
  }
  return out;
}

/** Stable short hash of the manifests + template version — the worker image cache key. */
export function manifestHash(manifests: CollectedManifest[], templateVersion: string): string {
  const h = createHash('sha256');
  h.update(`v:${templateVersion}`);
  for (const m of [...manifests].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`\0${m.path}\0${m.content}`);
  }
  return h.digest('hex').slice(0, 12);
}
