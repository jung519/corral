# Corral

> Open-source agent development orchestrator — **tracker → repository → human approval → AI coding agent**, runnable on your own machine with your own keys.

Corral takes an issue from your tracker, has an AI agent plan it, asks you to
approve the plan, implements it, self-reviews, and opens a pull request — with a
human in the loop at every gate. It is **provider-neutral** (Claude / Gemini /
GPT), **BYOK** (bring your own keys; nothing is embedded), and **self-hostable**.

Corral is the open-source successor to an internal tool called *Symphony*.

## ⬇ Download

**[Get the latest release →](https://github.com/jung519/corral/releases/latest)** — macOS &
Windows installers.

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Corral-<version>-arm64.dmg` |
| macOS (Intel) | `Corral-<version>.dmg` |
| Windows | `Corral-Setup-<version>.exe` |

> **Unsigned for now** — bypass the launch warning once: **macOS** right-click the app →
> **Open**; **Windows** on SmartScreen → **More info → Run anyway**. Prefer source?
> [Build it yourself.](#try-it-run-on-your-own-machine)

On first launch a **setup wizard** connects your AI provider, tracker, and repository — no
config files to edit.

## Status

**Works end-to-end** (issue → plan → your approval → code → self-review → pull request) and
is used daily on a real multi-repo project. Early and rough; installers are **unsigned**
until code-signing lands. Auto-update is built in.

## Try it (run on your own machine)

You don't edit any config files by hand — the app opens a **setup wizard** that walks you
through everything and stores your keys in your computer's keychain.

### 1. What you need first

- **Node.js 24+** and **pnpm** — the build tools. Get Node from [nodejs.org](https://nodejs.org);
  then install pnpm with `npm install -g pnpm`.
- **git** — to download the code and to open pull requests.
- **Docker Desktop** (recommended) — each task runs in its own isolated container.
  [Download Docker](https://www.docker.com/products/docker-desktop/). *(Or pick the “Local”
  backend in the wizard to skip Docker — then the agent runs directly on your machine.)*
- **One AI provider** — either
  - an official CLI installed and logged in (Claude Code, OpenAI **codex**, or **gemini**), **or**
  - an API key you paste into the wizard (Claude / Gemini / GPT).
- **A tracker** where your tasks live — Notion, GitHub Issues, or Jira.
- **A git host** where pull requests open — GitHub, GitLab, or Bitbucket.

### 2. Get it running

```bash
git clone https://github.com/jung519/corral.git
cd corral
pnpm install                 # core
pnpm -C renderer install     # dashboard UI
pnpm -C desktop install      # desktop shell
pnpm app                     # builds everything and opens the Corral app
```

The first launch opens the **setup wizard**: choose your AI provider, connect your tracker
and repository, and enter your keys (they go straight into the OS keychain — never into a
file). After that, the dashboard lists your issues: click one, approve the plan Corral
proposes, and it implements, self-reviews, and opens a pull request for you to merge.

To reopen the app later, just run `pnpm app` again from the `corral` folder.

> Advanced / headless (no GUI) usage and packaging are in [Development](#development) below.

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
