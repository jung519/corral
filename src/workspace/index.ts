/** Workspace axis registry. Keyed by backend (`docker` | `local`). */
import type { WorkspaceConfig } from '../config/schema.js';
import { Registry } from '../core/registry.js';
import type { WorkspaceAdapter } from '../core/types.js';
import { DockerWorkspace, dockerOptionsFromConfig } from './docker.js';
import { LocalWorkspace } from './local.js';

type WorkspaceRegistryConfig = WorkspaceConfig & { kind: string };

export interface WorkspaceCtx {
  /** Per-repository image override (node vs flutter), chosen by the orchestrator. */
  imageOverride?: string;
}

export const workspaces = new Registry<WorkspaceRegistryConfig, WorkspaceAdapter, WorkspaceCtx>('workspace');

workspaces.register('local', (cfg) => new LocalWorkspace(cfg.root));
workspaces.register('docker', (cfg, ctx) => new DockerWorkspace(dockerOptionsFromConfig(cfg.docker, ctx.imageOverride)));

export { dockerOptionsFromConfig } from './docker.js';
