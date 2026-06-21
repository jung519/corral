/**
 * Auto worker image — orchestration. Resolves a docker worker image for a set of
 * repos WITHOUT a pre-built image (the chicken-and-egg fix): manifests are read from
 * shallow host clones, a spec is chosen (heuristic, with an optional agent fallback),
 * the Dockerfile is rendered, gated on human approval, then built and cached by hash.
 *
 * Pure decision logic (chooseSpec) is testable; the impure shell (clone/build) needs
 * a working docker CLI and git, so callers reach it only on the docker backend.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../../core/logger.js';
import { run } from '../../util/exec.js';
import { buildImage, imageExists, workerImageTag } from './builder.js';
import { detectWorkerImage } from './detect.js';
import { renderDockerfile } from './dockerfile.js';
import { collectManifests, type CollectedManifest, manifestHash } from './manifest.js';
import { WORKER_IMAGE_TEMPLATE_VERSION, type WorkerImageSpec } from './spec.js';

/** Generate a spec from manifests via the agent (unfamiliar stacks); null on failure. */
export type AgentSpecFn = (manifests: CollectedManifest[]) => Promise<WorkerImageSpec | null>;

/** Hybrid choice: trust the heuristic when confident; otherwise ask the agent (if
 * available), falling back to the heuristic default. Pure — unit tested. */
export async function chooseSpec(
  manifests: CollectedManifest[],
  agentSpec?: AgentSpecFn,
): Promise<{ spec: WorkerImageSpec; source: 'heuristic' | 'agent' }> {
  const detected = detectWorkerImage(manifests);
  if (detected.confident || !agentSpec) return { spec: detected.spec, source: 'heuristic' };
  const fromAgent = await agentSpec(manifests).catch(() => null);
  return fromAgent ? { spec: fromAgent, source: 'agent' } : { spec: detected.spec, source: 'heuristic' };
}

export interface RepoCloneRef {
  key: string;
  cloneUrl: string;
  baseBranch: string;
}

export interface EnsureWorkerImageDeps {
  /** Host scratch dir for the shallow manifest clones (removed afterwards). */
  prepRoot: string;
  repos: RepoCloneRef[];
  /** Human gate: show the rendered Dockerfile, return whether to build it. */
  approve: (dockerfile: string, spec: WorkerImageSpec) => Promise<boolean>;
  /** Optional agent fallback for unfamiliar stacks (hybrid). */
  agentSpec?: AgentSpecFn;
  onLog?: (line: string) => void;
}

export type EnsureWorkerImageResult =
  | { ok: true; tag: string; cached: boolean }
  | { ok: false; reason: 'declined' | 'build_failed' | 'error'; message?: string };

/** Ensure a worker image exists for these repos; returns its tag. */
export async function ensureWorkerImage(deps: EnsureWorkerImageDeps): Promise<EnsureWorkerImageResult> {
  const log = logger.child('worker-image');
  const prep = resolve(deps.prepRoot);
  try {
    await rm(prep, { recursive: true, force: true });
    await mkdir(prep, { recursive: true });
    // Shallow-clone each repo just to read its manifests (no full history).
    for (const r of deps.repos) {
      const res = await run('git', ['clone', '--depth', '1', '--branch', r.baseBranch, r.cloneUrl, join(prep, r.key)]);
      if (res.code !== 0) log.warn(`manifest clone failed (${r.key}) — detection may be incomplete`);
    }

    const manifests = await collectManifests(prep, deps.repos.map((r) => r.key));
    const tag = workerImageTag(manifestHash(manifests, WORKER_IMAGE_TEMPLATE_VERSION));
    if (await imageExists(tag)) return { ok: true, tag, cached: true };

    const { spec, source } = await chooseSpec(manifests, deps.agentSpec);
    log.info(`worker image spec via ${source}: ${spec.base_image}`);
    const dockerfile = renderDockerfile(spec);

    if (!(await deps.approve(dockerfile, spec))) return { ok: false, reason: 'declined' };

    const build = await buildImage(dockerfile, tag, deps.onLog);
    if (!build.ok) return { ok: false, reason: 'build_failed', message: `docker build exited ${build.code}` };
    return { ok: true, tag, cached: false };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(prep, { recursive: true, force: true }).catch(() => {});
  }
}

export { detectWorkerImage } from './detect.js';
export { renderDockerfile } from './dockerfile.js';
export type { WorkerImageSpec } from './spec.js';
