import { describe, expect, it } from 'vitest';
import { dockerOptionsFromConfig } from './docker.js';
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
});

describe('LocalWorkspace', () => {
  it('reattach returns null when the workdir has no .git', async () => {
    const ws = new LocalWorkspace('/tmp/corral-nonexistent-xyz');
    expect(await ws.reattach('ISS-404')).toBeNull();
  });
});
