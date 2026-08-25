/**
 * A restart used to buy the same critique twice.
 *
 * The measured case (2026-08-23, on a real issue): round 1 finished at 07:41 and wrote its file;
 * the very next dispatch hit the daily token limit; the core was restarted to RAISE that
 * limit; recovery re-ran round 1 from scratch for 1,966,042 input tokens and $2.49, plus
 * eight minutes of someone waiting. The finished file was deleted on the way in.
 *
 * These tests count agent invocations, because that is what the money is.
 */
import { describe, expect, it } from 'vitest';
import { PlanReviewSchema, ProfileSchema } from '../config/schema.js';
import { resolveProfile } from '../profile/index.js';
import { SCRATCH } from '../core/paths.js';
import { PlanCritiqueOrchestrator } from './plan-critique.js';
import type { AgentAdapter, Issue, WorkspaceHandle, WorkspaceIO } from '../core/types.js';

const handle = { id: 'ws', workdir: '/ws', backend: 'local' } as unknown as WorkspaceHandle;
const issue: Issue = {
  identifier: 'ISS-1',
  internalId: 'x',
  title: 't',
  description: '',
  state: 'in_progress',
  labels: [],
  blockedBy: [],
  attachments: [],
};
const profile = resolveProfile(ProfileSchema.parse({ language: 'en', stack: 'nestjs' }));

/** A workspace whose `.corral/` contents are whatever the test says they are. */
function fakeIo(files: Record<string, string>) {
  const execs: string[] = [];
  const io = {
    async readFile(_h: WorkspaceHandle, path: string) {
      return files[path] ?? null;
    },
    async list(_h: WorkspaceHandle, dir: string) {
      return Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1));
    },
    async exec(_h: WorkspaceHandle, cmd: string) {
      execs.push(cmd);
      if (cmd.startsWith('rm -f ')) for (const p of cmd.slice(6).split(' ')) delete files[p];
      return { stdout: '', stderr: '', code: 0 };
    },
  } as unknown as WorkspaceIO;
  return { io, execs };
}

function fakeAgent() {
  const rounds: number[] = [];
  const agent = {
    kind: 'fake',
    primary: true,
    async run(_w: WorkspaceHandle, _i: Issue, opts: { prompt: string }) {
      rounds.push(Number(/\(round (\d+)\)/.exec(opts.prompt)?.[1]));
      return { ok: true } as never;
    },
  } as unknown as AgentAdapter;
  return { agent, rounds };
}

function build(files: Record<string, string>, cfgRounds = 2) {
  const { io, execs } = fakeIo(files);
  const { agent, rounds } = fakeAgent();
  const cfg = PlanReviewSchema.parse({ rounds: cfgRounds });
  return { orch: new PlanCritiqueOrchestrator(io, agent, cfg, profile), execs, rounds, files };
}

describe('a fresh cycle', () => {
  it('clears everything and runs every round', async () => {
    const { orch, execs, rounds } = build({ [SCRATCH.planCritique(1)]: 'old critique' });
    await orch.run(handle, issue, undefined);
    expect(execs.some((c) => c.includes('plan_critique_*.md'))).toBe(true);
    expect(rounds.sort()).toEqual([1, 2]);
  });

  it('still starts over when a human asked for another look', async () => {
    // The human pressed "review further". Reusing a critique they already read would
    // silently ignore the request — this path must stay expensive on purpose.
    const { orch, rounds } = build({
      [SCRATCH.planCritique(1)]: 'critique',
      [SCRATCH.planCritique(2)]: 'critique',
    });
    await orch.run(handle, issue, undefined, undefined, undefined, 'check the migration');
    expect(rounds.sort()).toEqual([1, 2]);
  });
});

describe('resuming an interrupted cycle', () => {
  it('runs nothing at all when every round already produced a file', async () => {
    // 07:41 in the measured run: vetting was DONE; what failed was the next dispatch.
    const { orch, rounds } = build({
      [SCRATCH.planCritique(1)]: 'critique',
      [SCRATCH.planCritique(2)]: 'critique',
    });
    const files = await orch.run(handle, issue, undefined, undefined, undefined, undefined, '', true);
    expect(rounds).toEqual([]);
    expect(files).toEqual([SCRATCH.planCritique(1), SCRATCH.planCritique(2)]);
  });

  it('runs only the rounds that are missing', async () => {
    // Rounds go out via Promise.all, so a partial result is the normal interrupted state.
    const { orch, rounds } = build({ [SCRATCH.planCritique(1)]: 'critique' });
    await orch.run(handle, issue, undefined, undefined, undefined, undefined, '', true);
    expect(rounds).toEqual([2]);
  });

  it('re-runs a round whose file is empty', async () => {
    // The agent writes the file itself; a core killed mid-write leaves zero bytes. Treating
    // that as finished would feed an empty critique into consolidation.
    const { orch, rounds } = build({
      [SCRATCH.planCritique(1)]: '   \n',
      [SCRATCH.planCritique(2)]: 'critique',
    });
    await orch.run(handle, issue, undefined, undefined, undefined, undefined, '', true);
    expect(rounds).toEqual([1]);
  });

  it('keeps live output but drops files past the round count', async () => {
    // The original wipe guarded against a shortened run leaving a stale higher-numbered
    // file for consolidation. That risk survives a restart, so it is handled precisely.
    const { orch, rounds, files } = build(
      {
        [SCRATCH.planCritique(1)]: 'critique',
        [SCRATCH.planCritique(2)]: 'critique',
        [SCRATCH.planCritique(3)]: 'from a longer previous run',
      },
      2,
    );
    await orch.run(handle, issue, undefined, undefined, undefined, undefined, '', true);
    expect(rounds).toEqual([]);
    expect(files[SCRATCH.planCritique(3)]).toBeUndefined();
    expect(files[SCRATCH.planCritique(1)]).toBe('critique');
  });

  it('runs everything when the restart left nothing behind', async () => {
    const { orch, rounds } = build({});
    await orch.run(handle, issue, undefined, undefined, undefined, undefined, '', true);
    expect(rounds.sort()).toEqual([1, 2]);
  });
});
