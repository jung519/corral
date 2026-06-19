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
| Tracker | `TrackerAdapter` | Notion |
| Repository | `RepositoryAdapter` | GitHub |
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

```bash
pnpm install
pnpm typecheck
pnpm test
```

Requires Node.js >= 24 and pnpm.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
