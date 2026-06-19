/**
 * Corral public surface (S1 — skeleton).
 *
 * Exposes the 5-axis adapter interfaces, the registry, the net-new agent and
 * credential boundaries, and the config schema. The orchestrator core is lifted
 * from upstream in S2 (see docs/development-plan.md §1.3) — there is no runnable
 * entrypoint yet.
 */
export * from './core/types.js';
export * from './core/registry.js';
export * from './agent/types.js';
export * from './credentials/types.js';
export { EnvCredentialStore } from './credentials/env-store.js';
export * from './config/schema.js';
