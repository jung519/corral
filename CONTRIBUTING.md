# Contributing to Corral

Thanks for your interest! Corral is an open-source agent development orchestrator.
This guide covers local setup and how to extend it.

## Setup

Requires Node.js >= 24 and pnpm.

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm -C renderer install
pnpm -C desktop install
```

See the [README](README.md) for how to run headless, run the desktop app in dev,
and build installers.

## Project layout

| Path | What |
|------|------|
| `src/` | Core: orchestrator, adapters, WebSocket control plane (headless) |
| `renderer/` | Svelte dashboard + setup wizard (talks to the core through the Electron bridge) |
| `desktop/` | Electron shell (lifecycle, keychain IPC, spawns the core) |
| `WORKFLOW.md` | The agent behavior contract (rendered per dispatch) |

## Architecture: the axes

Every external integration sits behind an adapter interface, selected by a `kind` field in
config and resolved through a `Registry` (`src/core/registry.ts`).

The development pillar has five, in `src/core/types.ts`: `TrackerAdapter`,
`RepositoryAdapter`, `AgentAdapter` (provider × transport), `WorkspaceAdapter`
(+`WorkspaceIO`), `ChannelAdapter`.

The operational pillar adds `TriggerAdapter` (`src/ops/trigger/types.ts`) — what starts a
pipeline: manual, a schedule, or a queue.

### Adding an adapter

1. Implement the interface (see `src/tracker/notion.ts` / `src/repository/github.ts`
   as references).
2. Add a config variant to the relevant `z.discriminatedUnion` in `src/config/schema.ts`.
3. Register it in the axis index (e.g. `src/tracker/index.ts`):
   `trackers.register('mykind', (config, ctx) => new MyTracker(config, ctx));`

Keep adapter-specific or project-specific strings out of the core — language and
calibration come from the profile (`src/profile/`).

## Conventions

- TypeScript, ESM, strict mode. Run `pnpm typecheck` and `pnpm test` before pushing.
- No project- or language-specific values in `src/` (the core stays generic).
- Secrets are never stored in config — only `CredentialRef` pointers.
- No proprietary binaries are bundled.

## Pull requests

Keep PRs focused. Include tests for new logic. Describe the change and how you
verified it.
