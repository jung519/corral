/**
 * Loads pipeline definitions off disk and refuses the broken ones at startup.
 *
 * **Why they aren't in corral.yaml.** The setup wizard rebuilds that file from scratch
 * every time you save a setting (`buildConfigYaml`), so anything it doesn't know about is
 * erased. Pipelines therefore live in their own directory, one YAML file each: adding or
 * deleting one is adding or deleting a file, and editing one never rewrites another's
 * bytes — which matters once the UI starts writing them.
 *
 * A bad definition fails **now**, with the file name and the field, rather than at 3am
 * when its trigger fires.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { PipelineSchema, type Pipeline } from './schema.js';

/** Default location, relative to the state directory. */
export const PIPELINES_DIR = 'pipelines';

export interface PipelineLoadIssue {
  /** File the problem is in, or '' for a problem across files (a duplicate key). */
  file: string;
  /** Dotted field path, e.g. `trigger.topic`. Empty when the whole document is at fault. */
  path: string;
  message: string;
}

export class PipelineLoadError extends Error {
  constructor(readonly issues: PipelineLoadIssue[]) {
    super(
      `${issues.length} problem(s) in pipeline definitions:\n` +
        issues.map((i) => `  ${[i.file, i.path].filter(Boolean).join(' → ')}: ${i.message}`).join('\n'),
    );
    this.name = 'PipelineLoadError';
  }
}

/**
 * Turn a Zod failure into per-field issues.
 *
 * Zod's own wording already distinguishes the three cases we care about — a missing
 * required field, a value of the wrong type, and an unrecognised adapter kind (the
 * discriminated unions report the kinds they do accept) — so the job here is to attach
 * the file and the field path rather than to reword any of it.
 */
function issuesFrom(file: string, err: z.ZodError): PipelineLoadIssue[] {
  return err.issues.map((i) => ({ file, path: i.path.join('.'), message: i.message }));
}

/** Validate one already-parsed document. Exported for the UI, which validates before it writes. */
export function parsePipeline(raw: unknown, file = ''): { pipeline?: Pipeline; issues: PipelineLoadIssue[] } {
  const result = PipelineSchema.safeParse(raw);
  return result.success ? { pipeline: result.data, issues: [] } : { issues: issuesFrom(file, result.error) };
}

/**
 * Read every `*.yaml` / `*.yml` in `dir` as one pipeline.
 *
 * A missing directory is not an error — no pipelines configured is a perfectly good state
 * (and the state a fresh install is in). Anything present but broken IS an error: silently
 * skipping it would leave an operator staring at a pipeline that never runs.
 */
export async function loadPipelines(dir: string): Promise<Pipeline[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    return [];
  }

  const pipelines: Pipeline[] = [];
  const issues: PipelineLoadIssue[] = [];
  const seen = new Map<string, string>(); // key → the file that claimed it

  for (const name of names) {
    let doc: unknown;
    try {
      doc = YAML.parse(await readFile(join(dir, name), 'utf8'));
    } catch (err) {
      issues.push({ file: name, path: '', message: `not valid YAML — ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (doc === null || doc === undefined) {
      issues.push({ file: name, path: '', message: 'file is empty' });
      continue;
    }

    const { pipeline, issues: found } = parsePipeline(doc, name);
    if (!pipeline) {
      issues.push(...found);
      continue;
    }

    // Two pipelines under one key would make history and manual runs ambiguous.
    const owner = seen.get(pipeline.key);
    if (owner) {
      issues.push({ file: name, path: 'key', message: `duplicate key "${pipeline.key}" — already defined in ${owner}` });
      continue;
    }
    seen.set(pipeline.key, name);
    pipelines.push(pipeline);
  }

  if (issues.length) throw new PipelineLoadError(issues);
  return pipelines;
}

/** The pipelines directory for a given state directory. */
export function pipelinesDir(stateDir: string): string {
  return join(stateDir, PIPELINES_DIR);
}
