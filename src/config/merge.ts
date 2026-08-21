/**
 * Keeping the parts of a config the wizard cannot write.
 *
 * The wizard is the only thing that writes `corral.yaml`, and it writes the file **from
 * scratch** every time — `buildConfigYaml` renders a whole document from the fields it
 * models. So anything it does not model was erased by any save. `limits` was one of
 * those, which meant a daily token ceiling could be typed into the file by hand and then
 * silently disappear the next time somebody changed a model name (CRL-77).
 *
 * `loader.ts` already says this out loud about pipelines — that is why they live in their
 * own directory rather than in this file. The same hazard was still here.
 *
 * ## What this does, and what it deliberately does not
 *
 * A **top-level block** the incoming document does not mention is carried over from the
 * file already on disk. Appended as text, so the wizard's own layout and header comment
 * survive untouched — re-serialising the whole document would rewrite formatting nobody
 * asked to change.
 *
 * It works at the top level only, and that is a decision rather than a limitation to fix
 * later. Merging *into* a block the wizard did write would make its fields impossible to
 * clear: emptying the reference repo, or turning off a tracker's scope property, both
 * work by the field simply not being written. A merge that filled those back in would be
 * a worse bug than the one this fixes.
 *
 * So a setting that lives inside a block the wizard writes has to be modelled by the
 * wizard to survive. `limits`, `workspace.docker.memory` and `workspace.docker.cpus` are
 * modelled for exactly that reason. What is left is written down in `UNMODELLED` below.
 */
import YAML from 'yaml';

/**
 * Top-level keys the wizard never writes. Anything here survives a save.
 *
 * Kept as a list rather than "whatever is missing" so that a block the wizard *stopped*
 * writing on purpose is not resurrected forever by accident.
 */
export const PRESERVED_BLOCKS = ['control_plane', 'review', 'plan_review'] as const;

/**
 * Fields inside blocks the wizard rewrites, which therefore do NOT survive a save.
 *
 * Not code — a list to read when someone asks "what does saving overwrite?". Anything
 * here that starts to matter gets modelled in the wizard, the way `limits` and the docker
 * caps were; carrying it over is not an option for the reason in the header.
 */
export const UNMODELLED = [
  'agent.max_turns',
  'agent.max_budget_usd',
  'agent.turn_timeout_ms',
  'agent.allowed_tools',
  // Written, but only ever as one value: the wizard has a single transport picker, so a
  // hand-written mix (cli to plan, api to review) collapses to that one on the next save.
  'agent.stages.*.transport (a per-stage mix)',
  'workspace.root',
  'workspace.docker.image',
  'workspace.docker.auto_build',
  'workspace.docker.env',
] as const;

/**
 * The document about to be written, with the preserved blocks put back.
 *
 * `existing` is whatever is on disk now, or null on a first save. Anything unreadable on
 * either side is left alone: this is a save path, and refusing to write because the old
 * file was corrupt would trap someone in a broken config.
 */
export function mergePreserved(incoming: string, existing: string | null): string {
  if (!existing) return incoming;

  let before: unknown;
  let after: unknown;
  try {
    before = YAML.parse(existing);
    after = YAML.parse(incoming);
  } catch {
    return incoming;
  }
  if (!isRecord(before) || !isRecord(after)) return incoming;

  const carried: Record<string, unknown> = {};
  for (const key of PRESERVED_BLOCKS) {
    if (before[key] !== undefined && after[key] === undefined) carried[key] = before[key];
  }
  if (!Object.keys(carried).length) return incoming;

  const text = YAML.stringify(carried, { lineWidth: 100 }).trimEnd();
  return `${incoming.trimEnd()}\n\n${text}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
