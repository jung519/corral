/** Local-filesystem workspace — reference adapter (S1 stub). */
import { notImplemented } from '../core/not-implemented.js';
import type { CreateWorkspaceInput, WorkspaceAdapter, WorkspaceHandle, WorkspaceIO } from '../core/types.js';
import { stubWorkspaceIO } from './stub-io.js';

export class LocalWorkspace implements WorkspaceAdapter {
  readonly kind = 'local';
  readonly io: WorkspaceIO = stubWorkspaceIO;

  create(_input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
    return notImplemented('local.create');
  }
  reattach(): Promise<WorkspaceHandle | null> {
    return notImplemented('local.reattach');
  }
  cleanup(): Promise<void> {
    return notImplemented('local.cleanup');
  }
}
