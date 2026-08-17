/**
 * Saving a pipeline definition the UI built.
 *
 * The file stays the source of truth. A pipeline created in the app lands as ordinary
 * YAML in the same folder as a hand-written one, readable and editable by hand — the app
 * is a convenient way to write the file, not a database that owns it. That is what lets
 * someone start in the UI and finish in an editor, or the reverse, or keep the whole set
 * in git.
 *
 * Which means two rules:
 *
 *   Nothing is written until it validates. A file that fails to load would leave the
 *   operator with an error banner and a pipeline they cannot fix from the screen that
 *   created it.
 *
 *   Editing writes back to the file that already holds that key, whatever it is called.
 *   Writing `<key>.yaml` regardless would leave the original in place and the loader
 *   would then refuse them both as duplicates.
 */
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { parsePipeline, type PipelineLoadIssue } from './loader.js';
import type { Pipeline } from './schema.js';

/**
 * Owner-only. A pipeline names the credentials it uses and can carry a token in a URL, and
 * it sits in the same state directory as `credentials.json` — which is already 0600. There
 * is no reason for the file that references a secret to be more readable than the file
 * holding it, and on a shared VM the difference is every other account on the box.
 */
const PRIVATE = 0o600;

export interface SaveResult {
  ok: boolean;
  /** Where it ended up, so the operator can find and edit it. */
  file?: string;
  /** Per-field problems, with the same dotted paths the loader reports. */
  issues?: PipelineLoadIssue[];
}

/** The file currently defining `key`, or undefined. */
export async function findPipelineFile(dir: string, key: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    return undefined;
  }
  for (const name of names.sort()) {
    try {
      const doc = YAML.parse(await readFile(join(dir, name), 'utf8')) as { key?: unknown } | null;
      if (doc && doc.key === key) return name;
    } catch {
      // Unreadable files are the loader's problem to report, not this one's.
    }
  }
  return undefined;
}

/**
 * Validate and write. `overwrite` is the difference between creating and editing: without
 * it, saving onto an existing key is refused rather than silently replacing a pipeline
 * someone else may be running.
 */
export async function savePipeline(
  dir: string,
  definition: unknown,
  options: { overwrite?: boolean } = {},
): Promise<SaveResult> {
  const { pipeline, issues } = parsePipeline(definition);
  if (!pipeline) return { ok: false, issues };

  const existing = await findPipelineFile(dir, pipeline.key);
  if (existing && !options.overwrite) {
    return {
      ok: false,
      issues: [{ file: existing, path: 'key', message: `a pipeline named "${pipeline.key}" already exists` }],
    };
  }

  const file = existing ?? `${pipeline.key}.yaml`;
  const path = join(dir, file);
  mkdirSync(dir, { recursive: true });
  await writeFile(path, toYaml(pipeline), { encoding: 'utf8', mode: PRIVATE });
  // `mode` on writeFile only applies when the file is created, so a pipeline written
  // before this existed would keep its old permissions forever. Set them either way.
  await chmod(path, PRIVATE).catch(() => {
    // Windows has no POSIX modes; the write already succeeded and that is what matters.
  });
  return { ok: true, file };
}

/**
 * Render a definition as YAML a person can read.
 *
 * Written from the parsed pipeline, so defaults the operator never typed become explicit
 * in the file — someone opening it later sees what will actually run rather than having
 * to know the schema's defaults by heart.
 */
export function toYaml(pipeline: Pipeline): string {
  return [
    '# Managed by Corral, and still just a file — edit it here or in the app.',
    YAML.stringify(pipeline, { lineWidth: 100 }),
  ].join('\n');
}
