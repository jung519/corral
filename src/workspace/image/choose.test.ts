import { describe, expect, it, vi } from 'vitest';
import { chooseSpec } from './index.js';
import type { CollectedManifest } from './manifest.js';
import type { WorkerImageSpec } from './spec.js';

const node: CollectedManifest[] = [{ path: 'server/package.json', content: '{}' }];
const unknown: CollectedManifest[] = [{ path: 'repo/Makefile', content: '' }];
const agentSpec: WorkerImageSpec = { base_image: 'custom:latest', system_packages: [], setup_commands: [], rationale: 'agent' };

describe('chooseSpec (hybrid)', () => {
  it('uses the heuristic and never calls the agent when confident', async () => {
    const agent = vi.fn();
    const r = await chooseSpec(node, agent);
    expect(r.source).toBe('heuristic');
    expect(agent).not.toHaveBeenCalled();
  });

  it('falls back to the agent for an unfamiliar stack', async () => {
    const r = await chooseSpec(unknown, async () => agentSpec);
    expect(r.source).toBe('agent');
    expect(r.spec.base_image).toBe('custom:latest');
  });

  it('uses the heuristic default when not confident and no agent is provided', async () => {
    const r = await chooseSpec(unknown);
    expect(r.source).toBe('heuristic');
    expect(r.spec.base_image).toBe('node:24-bookworm-slim');
  });

  it('falls back to the heuristic when the agent returns null', async () => {
    const r = await chooseSpec(unknown, async () => null);
    expect(r.source).toBe('heuristic');
  });
});
