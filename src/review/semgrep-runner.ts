/**
 * Runs semgrep inside the workspace and writes JSON results for the validator to
 * fold into the consolidated review. Lifted from upstream.
 *
 * Note: semgrep must be available on PATH in the workspace (worker image / host).
 * It is optional — omit `review.semgrep` in config to skip.
 */
import { SCRATCH } from '../core/paths.js';
import { logger } from '../core/logger.js';
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';

export interface SemgrepConfig {
  config: string[];
  paths: string[];
}

export async function runSemgrep(io: WorkspaceIO, handle: WorkspaceHandle, cfg: SemgrepConfig): Promise<boolean> {
  const configs = cfg.config.map((c) => `--config ${c}`).join(' ');
  const paths = cfg.paths.join(' ');
  const cmd = `semgrep ${configs} ${paths} --json --output ${SCRATCH.semgrep} --quiet || true`;
  const log = logger.child(handle.id);
  log.info('running semgrep');
  const res = await io.exec(handle, cmd);
  if (res.code !== 0) log.warn('semgrep exited non-zero', res.stderr.slice(-500));
  return io.exists(handle, SCRATCH.semgrep);
}
