/**
 * The operational AI's own run directory.
 *
 * The questions worth asking are the ones that would bite in production: does it clean up
 * after thousands of runs, and can the agent write outside it.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRunDir } from './run-dir.js';

const handle = { id: 'x', workdir: '', backend: 'local' as const };

describe('a place to run one operation', () => {
  it('is a real directory, named after nothing the agent sees', async () => {
    const dir = await makeRunDir('classify-1');

    expect(existsSync(dir.path)).toBe(true);
    expect(dir.handle).toMatchObject({ id: 'classify-1', workdir: dir.path, backend: 'local' });

    await dir.dispose();
  });

  it('goes away, including what the agent left in it', async () => {
    const dir = await makeRunDir('r');
    writeFileSync(join(dir.path, 'answer.json'), '{"a":1}');

    await dir.dispose();

    // Thousands of runs a day: one leftover folder each would fill the disk.
    expect(existsSync(dir.path)).toBe(false);
  });

  it('does not mind being disposed twice', async () => {
    const dir = await makeRunDir('r');
    await dir.dispose();

    await expect(dir.dispose()).resolves.toBeUndefined();
  });

  it('reads back what was written', async () => {
    const dir = await makeRunDir('r');

    await dir.io.writeFile(handle, 'nested/answer.json', '{"items":[]}');

    expect(await dir.io.readFile(handle, 'nested/answer.json')).toBe('{"items":[]}');
    expect(await dir.io.exists(handle, 'nested/answer.json')).toBe(true);
    expect(await dir.io.list(handle, 'nested')).toEqual(['answer.json']);
    await dir.dispose();
  });

  it('answers null for a file that is not there rather than throwing', async () => {
    const dir = await makeRunDir('r');

    expect(await dir.io.readFile(handle, 'nope.json')).toBeNull();
    expect(await dir.io.exists(handle, 'nope.json')).toBe(false);
    expect(await dir.io.list(handle, 'nope')).toEqual([]);
    await dir.dispose();
  });

  it('refuses a path that walks out of the directory', async () => {
    // The agent is told where to write; told is not guaranteed — the same reason the
    // answer is checked in code rather than trusted from the prompt.
    const dir = await makeRunDir('r');

    await expect(dir.io.writeFile(handle, '../escaped.json', 'x')).rejects.toThrow(/outside the run directory/);
    await expect(dir.io.writeFile(handle, '/etc/passwd', 'x')).rejects.toThrow(/outside the run directory/);
    await dir.dispose();
  });

  it('says plainly what it does not do', async () => {
    // git and running commands are the parts of a workspace that exist because the
    // development AI edits a repository. Half-working versions here would be the
    // boundary quietly moving.
    const dir = await makeRunDir('r');

    await expect(dir.io.getDiff(handle, 'HEAD')).rejects.toThrow(/no repository/);
    await expect(dir.io.exec(handle, 'ls')).rejects.toThrow(/does not run commands/);
    await dir.dispose();
  });
});
