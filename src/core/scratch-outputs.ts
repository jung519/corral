/**
 * Clearing the files a turn is about to write.
 *
 * A dispatch blanks its outputs before the agent runs, so that "the agent produced
 * nothing" is distinguishable from "the agent produced what was already there". The
 * orchestrator leans on that: an empty `pending_plan.md` after a planning turn is what
 * triggers a retry rather than presenting last cycle's plan as if it were new.
 *
 * **Only the outputs, though.** The same files are inputs to later turns — the guide tells
 * the implementation agent to read `pending_plan.md` and *"rely on the file, not memory of
 * the planning chat"*, and the fix agent to apply findings from `pending_review.md`. Those
 * turns used to start with the file blanked, so the instruction could only be followed by
 * the memory it told them not to use. It held up while one CLI session spanned both turns
 * and broke silently the moment it did not — a different provider per stage, or a restart
 * (CRL-88).
 *
 * So the caller says what this turn will produce, and nothing else is touched.
 */
import type { WorkspaceHandle, WorkspaceIO } from './types.js';

/**
 * Blank the given scratch files.
 *
 * An empty list writes nothing — a turn that produces no human-facing file has no business
 * clearing one.
 */
export async function wipeProduced(
  io: WorkspaceIO,
  handle: WorkspaceHandle,
  produced: readonly string[],
): Promise<void> {
  await Promise.all(produced.map((path) => io.writeFile(handle, path, '')));
}
