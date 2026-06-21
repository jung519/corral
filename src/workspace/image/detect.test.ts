import { describe, expect, it } from 'vitest';
import { detectWorkerImage } from './detect.js';
import type { CollectedManifest } from './manifest.js';

const mf = (path: string, content = ''): CollectedManifest => ({ path, content });

describe('detectWorkerImage', () => {
  it('detects a Node repo and its package manager', () => {
    const r = detectWorkerImage([mf('server/package.json'), mf('server/pnpm-lock.yaml')]);
    expect(r.confident).toBe(true);
    expect(r.spec.base_image).toBe('node:24-bookworm-slim');
    expect(r.spec.setup_commands).toContain('corepack enable');
  });

  it('picks the Flutter base for a node+flutter multi-repo and lists both runtimes', () => {
    const r = detectWorkerImage([mf('server/package.json'), mf('app/pubspec.yaml')]);
    expect(r.spec.base_image).toBe('ghcr.io/cirruslabs/flutter:stable');
    expect(r.runtimes).toEqual(expect.arrayContaining(['node', 'flutter']));
    expect(r.confident).toBe(true);
  });

  it('uses a Python base when only Python is present', () => {
    const r = detectWorkerImage([mf('svc/pyproject.toml')]);
    expect(r.spec.base_image).toBe('python:3.12-slim-bookworm');
  });

  it('adds python apt packages when python rides on a node base', () => {
    const r = detectWorkerImage([mf('server/package.json'), mf('server/requirements.txt')]);
    expect(r.spec.base_image).toBe('node:24-bookworm-slim');
    expect(r.spec.system_packages).toEqual(expect.arrayContaining(['python3', 'python3-pip']));
  });

  it('is not confident when no known manifest is found', () => {
    const r = detectWorkerImage([mf('repo/Makefile'), mf('repo/Dockerfile')]);
    expect(r.confident).toBe(false);
    expect(r.spec.base_image).toBe('node:24-bookworm-slim'); // safe default
  });
});
