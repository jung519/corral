/** Shared S1 stub WorkspaceIO — real file/exec wiring is lifted in S2. */
import { notImplemented } from '../core/not-implemented.js';
import type { WorkspaceIO } from '../core/types.js';

export const stubWorkspaceIO: WorkspaceIO = {
  readFile: () => notImplemented('workspace.readFile'),
  writeFile: () => notImplemented('workspace.writeFile'),
  exists: () => notImplemented('workspace.exists'),
  list: () => notImplemented('workspace.list'),
  getDiff: () => notImplemented('workspace.getDiff'),
  exec: () => notImplemented('workspace.exec'),
};
