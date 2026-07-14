import { describe, expect, it } from 'vitest';
import { renderDockerfile } from './dockerfile.js';
import { cliPackagesForProviders } from './index.js';
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
    // ~/.codex must exist and be worker-owned BEFORE the auth.json bind mount, or docker
    // creates the parent as root and codex dies with "Permission denied".
    expect(df).toContain('mkdir -p /home/worker/.codex && chown -R worker:worker /home/worker/.codex');
    expect(df).toContain('WORKDIR /workspace');
    expect(df).toContain('git config --global user.email'); // commit identity (fresh container has none)
  });

  it('works with no system packages or setup commands', () => {
    const df = renderDockerfile(WorkerImageSpecSchema.parse({ base_image: 'python:3.12-slim-bookworm' }));
    expect(df).toContain('FROM python:3.12-slim-bookworm');
    expect(df).not.toContain('apt-get install -y --no-install-recommends \\\n      '); // no spec apt block
    expect(df).toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('installs a CLI for each configured provider (cross-provider failover in docker)', () => {
    const df = renderDockerfile(nodeSpec, { agentClis: cliPackagesForProviders(['claude', 'gemini']) });
    expect(df).toContain('npm install -g @anthropic-ai/claude-code @google/gemini-cli');
  });

  it('rejects an unsafe CLI package name', () => {
    expect(() => renderDockerfile(nodeSpec, { agentClis: ['pkg; rm -rf /'] })).toThrow(/unsafe npm package/);
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

describe('cliPackagesForProviders', () => {
  it('defaults to the Claude CLI when empty/undefined', () => {
    expect(cliPackagesForProviders(undefined)).toEqual(['@anthropic-ai/claude-code']);
    expect(cliPackagesForProviders([])).toEqual(['@anthropic-ai/claude-code']);
  });

  it('maps providers, dedupes, sorts, and skips unknowns', () => {
    expect(cliPackagesForProviders(['gemini', 'claude', 'gemini'])).toEqual([
      '@anthropic-ai/claude-code',
      '@google/gemini-cli',
    ]);
    expect(cliPackagesForProviders(['gpt'])).toEqual(['@openai/codex']); // gpt → codex
    expect(cliPackagesForProviders(['bogus'])).toEqual(['@anthropic-ai/claude-code']); // unknown → default
  });
});
