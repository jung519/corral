# Quickstart (5 minutes)

Corral turns a tracker issue into a reviewed pull request, with you approving at
each gate. This walks through the headless setup; the desktop app wraps the same
flow with a setup wizard.

## 1. Prerequisites

- Node.js >= 24, pnpm
- A GitHub repo + token (repo scope)
- A Notion database + integration token
- One AI coding CLI installed and logged in, **or** an API key (BYOK). The
  reference path is the `claude` CLI.

## 2. Install & build

```bash
pnpm install
pnpm build
```

## 3. Configure

```bash
cp corral.example.yaml corral.yaml
```

Edit `corral.yaml`: set your Notion database id + property/state names, your
`owner/name` repo, and your agent provider/transport. **Secrets do not go in this
file** — they come from environment variables:

```bash
export CORRAL_NOTION_DEFAULT=secret_xxx        # Notion integration token
export CORRAL_GITHUB_DEFAULT=ghp_xxx           # GitHub token
export CORRAL_ANTHROPIC_DEFAULT=sk-ant-xxx     # API key (omit if using a logged-in CLI)
```

(The variable name is `CORRAL_<SERVICE>_<ACCOUNT>`, uppercased.)

## 4. Run

```bash
pnpm start corral.yaml
```

Open `http://localhost:4400`. Click **Import issues**, start one, and drive it:

1. **Plan** — the agent drafts a plan; independent critics vet it. Approve or give feedback.
2. **Implement** — the agent writes code on a work branch and commits.
3. **Self-review** — static gate + review rounds; blockers/suggestions auto-fixed, then shown.
4. **PR** — on approval Corral pushes the branch and opens the PR.
5. **Complete** — after you merge, press **Complete** to clean up.

## Desktop app

Prefer a GUI? See the README's "Run the desktop app" and "Package installers"
sections — first run shows a setup wizard and stores secrets in the OS keychain.

## Troubleshooting

- **Port in use** — change `channel.port` in `corral.yaml`.
- **Empty diff / no changes** — the agent didn't commit to the workspace; check the
  repo config and that the work branch is correct.
- **Auth errors** — verify the `CORRAL_*` token, or that your provider CLI is logged in.
