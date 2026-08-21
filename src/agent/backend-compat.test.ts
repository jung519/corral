import { describe, expect, it } from 'vitest';
import { unrunnableProvider } from './backend-compat.js';

describe('unrunnableProvider', () => {
  it('blocks gemini:cli under docker — nothing puts a gemini login in the image', () => {
    expect(unrunnableProvider({ provider: 'gemini', transport: 'cli' }, 'docker')).toBe('gemini');
  });

  it('allows gemini:api under docker — the core makes that call, not the container', () => {
    expect(unrunnableProvider({ provider: 'gemini', transport: 'api' }, 'docker')).toBeNull();
  });

  it('allows gemini:cli on the local backend — the CLI there is the one the operator already logged in', () => {
    expect(unrunnableProvider({ provider: 'gemini', transport: 'cli' }, 'local')).toBeNull();
  });

  it.each(['claude', 'gpt'])('allows %s:cli under docker — both have an in-container login', (provider) => {
    expect(unrunnableProvider({ provider, transport: 'cli' }, 'docker')).toBeNull();
  });
});
