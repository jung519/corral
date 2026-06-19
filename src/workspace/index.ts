/** Workspace axis registry. Keyed by backend (`docker` | `local`). */
import { Registry } from '../core/registry.js';
import type { WorkspaceAdapter } from '../core/types.js';
import { DockerWorkspace } from './docker.js';
import { LocalWorkspace } from './local.js';

export const workspaces = new Registry<{ kind: string }, WorkspaceAdapter>('workspace');

workspaces.register('local', () => new LocalWorkspace());
workspaces.register('docker', () => new DockerWorkspace());
