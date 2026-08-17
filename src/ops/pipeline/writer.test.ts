/**
 * Saving what an editor built.
 *
 * The rules that matter: nothing invalid reaches disk, an edit lands in the file that
 * already holds that key, and what comes out is a file a person can open and change.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPipelines } from './loader.js';
import { findPipelineFile, savePipeline, toYaml } from './writer.js';
import { PipelineSchema } from './schema.js';

let dir: string;

const DEFINITION = {
  key: 'classify-record',
  description: 'label incoming records',
  trigger: { kind: 'manual' },
  input: { kind: 'none', select: { title: 'title' }, require: ['title'] },
  agent: {
    prompt: { system: 'You label records.', user_template: 'Title: {{title}}' },
    schema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
  },
  output: { kind: 'none' },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-writer-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('saving a new pipeline', () => {
  it('writes a file the loader can read straight back', async () => {
    const result = await savePipeline(dir, DEFINITION);

    expect(result).toMatchObject({ ok: true, file: 'classify-record.yaml' });
    const [loaded] = await loadPipelines(dir);
    expect(loaded.key).toBe('classify-record');
    expect(loaded.input.select).toEqual({ title: 'title' });
  });

  it('creates the folder when this is the first one', async () => {
    const fresh = join(dir, 'pipelines');

    await savePipeline(fresh, DEFINITION);

    expect(existsSync(join(fresh, 'classify-record.yaml'))).toBe(true);
  });

  it('produces something a person can open and change', async () => {
    await savePipeline(dir, DEFINITION);

    const text = readFileSync(join(dir, 'classify-record.yaml'), 'utf8');
    expect(text).toContain('key: classify-record');
    expect(text).toContain('You label records.');
    // The file is the source of truth, not an export — say so where it will be read.
    expect(text).toContain('still just a file');
  });

  it('spells out the defaults nobody typed', async () => {
    await savePipeline(dir, DEFINITION);

    // Someone opening the file later should see what will actually run, rather than
    // having to know the schema's defaults by heart.
    const text = readFileSync(join(dir, 'classify-record.yaml'), 'utf8');
    expect(text).toContain('enabled: true');
    expect(text).toContain('max_concurrent: 1');
    expect(text).toContain('max_tokens: 4096');
  });
});

describe('who can read it', () => {
  // Windows has no POSIX modes; there is nothing to assert there.
  const posix = process.platform !== 'win32';

  it.runIf(posix)('writes the file owner-only', async () => {
    await savePipeline(dir, DEFINITION);

    // It names the credentials it uses and sits beside credentials.json, which is 0600.
    expect(statSync(join(dir, 'classify-record.yaml')).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('tightens a file that was already there', async () => {
    // `mode` on writeFile only applies to a file being created, so a pipeline written
    // before this rule existed would keep its old permissions forever.
    writeFileSync(join(dir, 'classify-record.yaml'), 'key: classify-record\n', { mode: 0o644 });

    await savePipeline(dir, DEFINITION, { overwrite: true });

    expect(statSync(join(dir, 'classify-record.yaml')).mode & 0o777).toBe(0o600);
  });
});

describe('nothing invalid reaches disk', () => {
  it('refuses and says which fields, without writing anything', async () => {
    const result = await savePipeline(dir, { key: 'NOT A KEY', trigger: { kind: 'manual' } });

    expect(result.ok).toBe(false);
    expect(result.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(['key', 'input', 'agent', 'output']));
    expect(existsSync(join(dir, 'NOT A KEY.yaml'))).toBe(false);
  });

  it('reports paths an editor can put next to the field that caused them', async () => {
    const result = await savePipeline(dir, {
      ...DEFINITION,
      agent: { ...DEFINITION.agent, schema: { type: 'object', properties: {} } },
    });

    expect(result.issues?.[0].path).toBe('agent.schema');
    expect(result.issues?.[0].message).toMatch(/at least one property/);
  });

  it('leaves a good file untouched when a bad edit is refused', async () => {
    await savePipeline(dir, DEFINITION);
    const before = readFileSync(join(dir, 'classify-record.yaml'), 'utf8');

    await savePipeline(dir, { ...DEFINITION, trigger: { kind: 'carrier-pigeon' } }, { overwrite: true });

    expect(readFileSync(join(dir, 'classify-record.yaml'), 'utf8')).toBe(before);
  });
});

describe('editing an existing one', () => {
  it('refuses to replace it unless asked', async () => {
    await savePipeline(dir, DEFINITION);

    const result = await savePipeline(dir, { ...DEFINITION, description: 'changed' });

    // Silently replacing a pipeline someone else may be running is not a save.
    expect(result).toMatchObject({ ok: false });
    expect(result.issues?.[0]).toMatchObject({ path: 'key' });
  });

  it('replaces it when asked', async () => {
    await savePipeline(dir, DEFINITION);

    await savePipeline(dir, { ...DEFINITION, description: 'changed' }, { overwrite: true });

    expect((await loadPipelines(dir))[0].description).toBe('changed');
  });

  it('writes back to the file that already holds the key, whatever it is called', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hand-written.yaml'), toYaml(PipelineSchema.parse(DEFINITION)));

    const result = await savePipeline(dir, { ...DEFINITION, description: 'edited' }, { overwrite: true });

    // Writing `<key>.yaml` regardless would leave the original in place, and the loader
    // would then refuse them both as duplicates.
    expect(result.file).toBe('hand-written.yaml');
    expect(existsSync(join(dir, 'classify-record.yaml'))).toBe(false);
    expect((await loadPipelines(dir))[0].description).toBe('edited');
  });

  it('finds nothing for a key that is not there', async () => {
    await expect(findPipelineFile(dir, 'ghost')).resolves.toBeUndefined();
  });

  it('ignores an unreadable neighbour while looking', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.yaml'), 'key: [unclosed');
    await savePipeline(dir, DEFINITION);

    await expect(findPipelineFile(dir, 'classify-record')).resolves.toBe('classify-record.yaml');
  });
});
