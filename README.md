# Corral

> Open-source AI orchestrator you run yourself — **coding agents for the work you approve,
> pipelines for the work that repeats.**

Corral does two jobs on one setup. They share your provider, your keys and a single daily
ceiling — in tokens, in dollars, or both; the app shows one at a time so the other's screens
stay out of the way.

**Development — an issue becomes a pull request.**
`tracker → plan → your approval → code → self-review → pull request`
Corral takes an issue from your tracker, has an agent plan it, asks you to approve the plan
before a line is written, implements it, reviews its own work, and opens a pull request.
A human is at every gate.

*Optional:* turn on **spec mode** and that one plan becomes three — requirements, design,
tasks — each approved on its own, with the implementation then working the task list one
task at a time and the dashboard showing how far it has got. It costs roughly 2.4× the model
calls per issue, so it is off by default. See [`docs/spec-mode.md`](docs/spec-mode.md).

**Operations — a queue becomes an answer.**
`trigger → fetch → one model turn → checks → your API`
A pipeline is one YAML file: what wakes it (a queue, a schedule, or you), what to read from
your own API, one turn with a declared answer shape, rules that re-check the answer **in
code**, and where the result goes. Nobody approves each item — the checks are the gate, and
a doubtful answer is held back with a link rather than written.

Both are **provider-neutral** (Claude / Gemini / GPT), **BYOK** (bring your own keys;
nothing is embedded), and **self-hostable**.

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

**Development works end-to-end** (issue → plan → your approval → code → self-review → pull
request) and is used daily on a real multi-repo project.

**Operations is newer.** Pipelines run end-to-end — trigger, fetch, structured answer,
validation, delivery — and are being put into real use now. Expect the rough edges of
something young.

Early overall; installers are **unsigned** until code-signing lands. Auto-update is built in.

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

> Want it running on a server instead of your laptop — with the app connecting to it from
> anywhere? See [Run it on a server](docs/vm-deploy.md). Packaging and other advanced usage
> are in [Development](#development) below.

## Architecture (6 pluggable axes)

Every external integration sits behind an adapter interface, selected by a
`kind` field in config and resolved through a registry:

| Axis | Interface | Reference impl | Used by |
|------|-----------|----------------|---------|
| Tracker | `TrackerAdapter` | Notion, GitHub Issues, Jira | Development |
| Repository | `RepositoryAdapter` | GitHub, GitLab, Bitbucket | Development |
| Workspace | `WorkspaceAdapter` + `WorkspaceIO` | Docker, Local | Development |
| Channel | `ChannelAdapter` | Web (Slack optional) | Development |
| Trigger | `TriggerAdapter` | Manual, Schedule (cron), Google Pub/Sub | Operations |
| Agent | `AgentAdapter` (provider × transport) | Claude (api/cli) | Both |

Adding an integration = one adapter implementation + one config schema variant
+ one registry registration.

A pipeline's own steps — what it reads, how the answer is checked, where the result goes —
are **not** an axis. They are fields in the pipeline file, because a declaration someone can
read and edit is the point; see [the operations design note](docs/operational-ai-design.md)
for what that declaration can and cannot express.

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

The core runs on its own — no Electron, no renderer, not even a config file to start with.
It opens a WebSocket **control plane** and waits; you attach the desktop app to it from
another machine and set it up from there.

```bash
pnpm install && pnpm build              # core only — renderer/desktop are not needed
pnpm start corral.yaml                  # control plane on ws://127.0.0.1:4410
```

It prints a **6-digit pairing code**. In the desktop app: **Settings → Core connection →
Another computer**, give it the server (`user@host`) and the code.

There is no HTTP dashboard and no port to open in a browser — the desktop app *is* the
client. Binding stays on `127.0.0.1`, and the app carries the connection over SSH itself —
so there is nothing to open in a firewall and no terminal to leave running. Uncheck that
if you already have a tunnel or an overlay network and want the address used as-is.
`--control-plane [host:]port` overrides the address the core binds.

If you already have a `corral.yaml`, secrets come from the environment as
`CORRAL_<SERVICE>_<ACCOUNT>` — the account is the one named in that credential's config
entry, so `corral.example.yaml` wants `CORRAL_GITHUB_SERVER`, not `..._DEFAULT`:

```bash
cp corral.example.yaml corral.yaml      # edit it
export CORRAL_NOTION_DEFAULT=...        # see the header of corral.example.yaml
export CORRAL_GITHUB_SERVER=...         # matches `account: server` in that file
export CORRAL_ANTHROPIC_DEFAULT=...
pnpm start corral.yaml
```

Running it on a server long-term (systemd, Docker, provider login without a browser):
**[docs/vm-deploy.md](docs/vm-deploy.md)**.

#### Where secrets come from

Nothing in a config file or a pipeline file is ever a secret — those name a credential,
and the value is looked up at call time. The core reads two places, in order:

| | | |
|---|---|---|
| 1 | **Environment** | `CORRAL_<SERVICE>_<ACCOUNT>`. Read-only, and it wins — which is how one machine overrides another without editing anything |
| 2 | **`<state dir>/credentials.json`** | mode `0600`, written by the setup wizard. This is where the app saves what you type |

Corral does not read a `.env` file itself. Putting those variables in the environment is
your process manager's job — Compose's `env_file`, systemd's `EnvironmentFile`, or a
`source` in your shell. That keeps one loader in the tool that already owns the process.

The desktop app in local mode is the same picture from the other side: it encrypts secrets
with the OS keychain and passes them to the core it spawns as `CORRAL_*` variables. Pointed
at a remote core, it sends them over the control plane and that core writes its own
`credentials.json`.

### Run the desktop app (dev)

```bash
pnpm build                              # build the core
pnpm -C renderer dev                    # Vite dev server on :5173 (terminal 1)
# terminal 2:
pnpm -C desktop build
CORRAL_RENDERER_URL=http://localhost:5173 CORRAL_CORE_ENTRY="$PWD/dist/ipc-main.js" pnpm -C desktop start
```

`ipc-main.js` is the entry the desktop forks (it talks over the process IPC channel);
`main.js` is the headless one and has no such channel.

The wizard writes config to the OS app-data dir and secrets to the OS keychain.

### Package installers

```bash
pnpm package            # builds core + renderer + desktop, then electron-builder
```

Output lands in `desktop/release/`. No proprietary binaries are bundled — provider
CLIs are detected on the user's machine, never redistributed.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
