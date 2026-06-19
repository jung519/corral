/**
 * Minimal attachment handling: download text/markdown attachments into the
 * workspace so the agent can read them; everything else is listed in a manifest.
 * Non-fatal. (A richer pdf/image reader can be lifted later.)
 */
import { logger } from './core/logger.js';
import { SCRATCH } from './core/paths.js';
import type { Issue, WorkspaceHandle, WorkspaceIO } from './core/types.js';

export async function processAttachments(io: WorkspaceIO, handle: WorkspaceHandle, issue: Issue): Promise<void> {
  if (issue.attachments.length === 0) return;
  const log = logger.child(issue.identifier);
  const manifest: string[] = [];

  for (const att of issue.attachments) {
    const dest = `${SCRATCH.attachmentsDir}/${att.name}`;
    if (att.kind === 'md') {
      try {
        const res = await fetch(att.url);
        if (res.ok) {
          await io.writeFile(handle, dest, await res.text());
          manifest.push(`- ${att.name} (downloaded → ${dest})`);
          continue;
        }
      } catch (err) {
        log.warn(`attachment download failed: ${att.name}`, String(err));
      }
    }
    manifest.push(`- ${att.name} [${att.kind}] ${att.url}`);
  }

  await io.writeFile(handle, `${SCRATCH.attachmentsDir}/manifest.md`, `# Attachments\n${manifest.join('\n')}\n`);
}
