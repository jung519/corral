/** Docker-container workspace — reference adapter (S1 stub). */
import { notImplemented } from '../core/not-implemented.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { stubWorkspaceIO } from './stub-io.js';

export class DockerWorkspace implements WorkspaceAdapter {
  readonly kind = 'docker';
  readonly io: WorkspaceIO = stubWorkspaceIO;

  create(_input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
    return notImplemented('docker.create');
  }
  reattach(): Promise<WorkspaceHandle | null> {
    return notImplemented('docker.reattach');
  }
  cleanup(): Promise<void> {
    return notImplemented('docker.cleanup');
  }
}
