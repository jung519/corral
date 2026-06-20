# Corral

> Open-source agent development orchestrator — **tracker → repository → human approval → AI coding agent**, runnable on your own machine with your own keys.

Corral takes an issue from your tracker, has an AI agent plan it, asks you to
approve the plan, implements it, self-reviews, and opens a pull request — with a
human in the loop at every gate. It is **provider-neutral** (Claude / Gemini /
GPT), **BYOK** (bring your own keys; nothing is embedded), and **self-hostable**.

Corral is the open-source successor to an internal tool called *Symphony*.

## Status

🚧 **Early development (S1 — skeleton).** Interfaces and the adapter/registry
boundary are being established; the orchestrator core is lifted in a later
milestone. Not yet usable end-to-end. See [docs/development-plan.md](docs/development-plan.md).

## Architecture (5 pluggable axes)

Every external integration sits behind an adapter interface, selected by a
`kind` field in config and resolved through a registry:

| Axis | Interface | Reference impl |
|------|-----------|----------------|
| Tracker | `TrackerAdapter` | Notion, GitHub Issues, Jira |
| Repository | `RepositoryAdapter` | GitHub, GitLab, Bitbucket |
| Agent | `AgentAdapter` (provider × transport) | Claude (api/cli) |
| Workspace | `WorkspaceAdapter` + `WorkspaceIO` | Docker, Local |
| Channel | `ChannelAdapter` | Web (Slack optional) |

Adding an integration = one adapter implementation + one config schema variant
+ one registry registration.

## Principles

- **BYOK** — credentials are yours, stored in the OS keychain; the app embeds no keys.
- **No bundled proprietary binaries** — provider CLIs are detected, never redistributed.
- **Headless first** — the core runs without a GUI; the desktop app wraps it.

## Development

The repo has three packages: the core (root, headless orchestrator + control plane),
`renderer/` (Svelte dashboard + setup wizard), and `desktop/` (Electron shell).

```bash
pnpm install            # core deps
pnpm typecheck && pnpm test
pnpm -C renderer install && pnpm -C desktop install
```

Requires Node.js >= 24 and pnpm.

### Run headless (no GUI)

```bash
cp corral.example.yaml corral.yaml      # edit it
export CORRAL_NOTION_DEFAULT=...        # BYOK secrets (see corral.example.yaml)
export CORRAL_GITHUB_DEFAULT=...
export CORRAL_ANTHROPIC_DEFAULT=...
pnpm build && pnpm start corral.yaml    # control plane on http://localhost:4400
```

### Run the desktop app (dev)

```bash
pnpm build                              # build the core
pnpm -C renderer dev                    # Vite dev server on :5173 (terminal 1)
# terminal 2:
pnpm -C desktop build
CORRAL_RENDERER_URL=http://localhost:5173 CORRAL_CORE_ENTRY="$PWD/dist/main.js" pnpm -C desktop start
```

The wizard writes config to the OS app-data dir and secrets to the OS keychain.

### Package installers

```bash
pnpm package            # builds core + renderer + desktop, then electron-builder
```

Output lands in `desktop/release/`. No proprietary binaries are bundled — provider
CLIs are detected on the user's machine, never redistributed.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
