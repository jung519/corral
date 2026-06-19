/**
 * Static verification gate. Runs the repo's `verify` commands (lint / typecheck /
 * analyze) INSIDE the workspace — NO app execution — and writes the results as
 * deterministic facts for the reviewer + consolidator.
 *
 * A non-zero exit is an objective fact the LLM reviewer cannot rationalize away;
 * the consolidator folds any failed command as a BLOCKER. Lifted from upstream.
 */
import { SCRATCH } from '../core/paths.js';
import { logger } from '../core/logger.js';
import type { WorkspaceHandle, WorkspaceIO } from '../core/types.js';

/** Keep the persisted output bounded — only the tail matters for diagnosis. */
const MAX_OUTPUT_CHARS = 4000;

export interface StaticQaCommandResult {
  command: string;
  code: number;
  output: string;
}

export interface StaticQaReport {
  ran: boolean;
  anyFailed: boolean;
  results: StaticQaCommandResult[];
}

/** Runs each verify command sequentially and writes the report. Never throws. */
export async function runStaticQa(
  io: WorkspaceIO,
  handle: WorkspaceHandle,
  commands: string[],
): Promise<StaticQaReport> {
  const log = logger.child(handle.id);
  if (commands.length === 0) return { ran: false, anyFailed: false, results: [] };

  const results: StaticQaCommandResult[] = [];
  for (const command of commands) {
    log.info(`static-qa: ${command}`);
    try {
      const res = await io.exec(handle, command);
      const merged = `${res.stdout}\n${res.stderr}`.trim();
      results.push({
        command,
        code: res.code,
        output: merged.length > MAX_OUTPUT_CHARS ? merged.slice(-MAX_OUTPUT_CHARS) : merged,
      });
      if (res.code !== 0) log.warn(`static-qa FAILED (code ${res.code}): ${command}`);
    } catch (err) {
      results.push({ command, code: -1, output: `runner error: ${String(err)}` });
      log.warn(`static-qa threw for "${command}"`, String(err));
    }
  }

  const report: StaticQaReport = {
    ran: true,
    anyFailed: results.some((r) => r.code !== 0),
    results,
  };
  await io.writeFile(handle, SCRATCH.staticQa, JSON.stringify(report, null, 2));
  return report;
}
