import { describe, expect, it } from 'vitest';
import { renderDockerfile } from './dockerfile.js';
import { WorkerImageSpecSchema } from './spec.js';

const nodeSpec = WorkerImageSpecSchema.parse({
  base_image: 'node:24-bookworm-slim',
  system_packages: ['jq'],
  setup_commands: ['corepack enable'],
  rationale: 'pnpm-lock detected',
});

describe('renderDockerfile', () => {
  it('renders the spec plus the guaranteed Corral runtime layer', () => {
    const df = renderDockerfile(nodeSpec);
    expect(df).toContain('FROM node:24-bookworm-slim');
    expect(df).toContain('jq'); // system package
    expect(df).toContain('RUN corepack enable'); // setup command
    expect(df).toContain('npm install -g @anthropic-ai/claude-code'); // guaranteed
    expect(df).toContain('USER worker'); // non-root
    expect(df).toContain('WORKDIR /workspace');
    expect(df).toContain('git config --global user.email'); // commit identity (fresh container has none)
  });

  it('works with no system packages or setup commands', () => {
    const df = renderDockerfile(WorkerImageSpecSchema.parse({ base_image: 'python:3.12-slim-bookworm' }));
    expect(df).toContain('FROM python:3.12-slim-bookworm');
    expect(df).not.toContain('apt-get install -y --no-install-recommends \\\n      '); // no spec apt block
    expect(df).toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('rejects an unsafe base image', () => {
    expect(() => renderDockerfile(WorkerImageSpecSchema.parse({ base_image: 'node:24 && rm -rf /' }))).toThrow(/unsafe base/);
  });

  it('rejects an unsafe apt package', () => {
    expect(() =>
      renderDockerfile(WorkerImageSpecSchema.parse({ base_image: 'node:24', system_packages: ['git; curl evil'] })),
    ).toThrow(/unsafe apt/);
  });

  it('rejects a multi-line setup command (Dockerfile injection)', () => {
    expect(() =>
      renderDockerfile(WorkerImageSpecSchema.parse({ base_image: 'node:24', setup_commands: ['ok\nUSER root'] })),
    ).toThrow(/single line/);
  });
});
