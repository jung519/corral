import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkspaceSchema } from '../config/schema.js';
import { codexAuthMounted, dockerOptionsFromConfig, hostCodexAuthPath } from './docker.js';
import { LocalWorkspace } from './local.js';

describe('dockerOptionsFromConfig', () => {
  it('defaults the image when none is configured', () => {
    expect(dockerOptionsFromConfig(undefined).image).toBe('corral-worker:latest');
  });

  it('honors config and an image override', () => {
    const opts = dockerOptionsFromConfig({ image: 'cfg-image', memory: '2g' }, 'override-image');
    expect(opts.image).toBe('override-image');
    expect(opts.memory).toBe('2g');
  });

  it('does not mount the codex credential unless bootstrap opted in', () => {
    expect(dockerOptionsFromConfig(undefined).mountCodexAuth).toBe(false);
  });
});

describe('codexAuthMounted', () => {
  it('is false for the local backend (nothing to mount into)', () => {
    expect(codexAuthMounted(WorkspaceSchema.parse({ backend: 'local' }))).toBe(false);
  });

  // `mount_host_login` is about the ~/.claude directory. Gating codex on it silently broke
  // the review stage (login_required) for operators who key-authenticate claude.
  it('is independent of the claude host-login mount flag', () => {
    expect(codexAuthMounted(WorkspaceSchema.parse({ backend: 'docker', docker: { mount_host_login: false } }))).toBe(
      existsSync(hostCodexAuthPath()),
    );
  });

  // `codex login --with-api-key` REWRITES auth.json; an in-place write passes through the
  // bind mount and would destroy the operator's ChatGPT login on the host.
  it('is false when a gpt CLI member authenticates with an API key', () => {
    expect(codexAuthMounted(WorkspaceSchema.parse({ backend: 'docker' }), true)).toBe(false);
  });
});

describe('LocalWorkspace', () => {
  it('reattach returns null when the workdir has no .git', async () => {
    const ws = new LocalWorkspace('/tmp/corral-nonexistent-xyz');
    expect(await ws.reattach('ISS-404')).toBeNull();
  });
});
