# Run Corral on a server

Corral's core doesn't need a screen. Put it on a VM (EC2, a droplet, a box under your
desk) and it keeps working while your laptop is closed — you attach the desktop app to it
when you want to look, approve a plan, or start an issue.

This guide goes from a bare Linux machine to "the app on my laptop is driving it".

Every Corral command below was run against a fresh clone and behaves as printed. The one
thing that needs your machine rather than Corral's — the systemd unit — is standard for
that tool and is the only step not exercised here, along with the provider login marked ⚠.
The SSH tunnel used to be on this list; the app opens it now (step 6).

---

## The shape of it

```
   your laptop                              your server
┌──────────────────┐                  ┌──────────────────────┐
│  Corral desktop  │ ═══ SSH tunnel ══│  corral core         │
│  (dashboard,     │   ws://127.0.0.1 │  agents, containers, │
│   approvals)     │        :4410     │  git clones          │
└──────────────────┘                  └──────────────────────┘
```

The core listens on **loopback only**. The tunnel is what makes it reachable, so there is
no port on the public internet and no TLS to configure — **and the app opens that tunnel
itself**, so it isn't a step you have to keep alive. Close the laptop and the server keeps
going; reopen it and the app reopens the tunnel and reconnects on its own.

---

## 1. What the server needs

- **Node.js 24 or newer** and **pnpm** (`npm install -g pnpm`)
- **git**
- **Docker** — optional but recommended, so each issue gets its own container. Without it,
  pick the `local` workspace backend in the wizard and the agent runs directly on the box.
- an **AI provider** reachable from the server (see step 5)

No renderer, no Electron, no display server.

## 2. Install

```bash
git clone https://github.com/jung519/corral.git
cd corral
pnpm install
pnpm build
```

`pnpm install` at the repo root installs the core only. You do **not** need
`pnpm -C renderer install` or `pnpm -C desktop install` on the server — those build the
desktop app, which runs on your laptop.

## 3. Start it

```bash
pnpm start ~/corral/corral.yaml
```

The config file does not have to exist yet. With no config the core comes up in **setup
mode** and waits — you'll create the config from the app in step 6. It prints two things
you need:

```
INFO  corral starting in setup mode (no config yet)
INFO  control plane pairing code: 083411 (valid 5 minutes, single use)
INFO  ws control plane listening on 127.0.0.1:4410
INFO  corral running headless — attach the desktop app to this control plane
```

The pairing code is single-use and expires in five minutes. If you miss it, restart with
`--pair` to get a new one. Options:

| | |
|---|---|
| `pnpm start <config>` | config path (created for you if missing) |
| `--control-plane [host:]port` | where to listen. Default `127.0.0.1:4410` |
| `--pair` | issue a fresh pairing code even if a device is already paired |
| `--revoke <label\|all>` | drop a paired device |
| `CORRAL_STATE_DIR` | where issue state, credentials and tokens live. Default `.corral-state` |

> **Don't bind `0.0.0.0`** unless something else is protecting the port. The plane is
> authenticated but **not encrypted** — it's meant to sit behind a tunnel or a VPN. The
> core logs a warning when you bind anywhere but loopback.

## 4. Keep it running (systemd)

```ini
# /etc/systemd/system/corral.service
[Unit]
Description=Corral core
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=corral
WorkingDirectory=/home/corral/corral
Environment=CORRAL_STATE_DIR=/home/corral/.corral-state
ExecStart=/usr/bin/node dist/main.js /home/corral/corral.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now corral
journalctl -u corral -f          # this is where the pairing code appears
```

`ExecStart` calls `node dist/main.js` rather than `pnpm start` so systemd supervises the
core itself instead of a package-manager wrapper — otherwise `systemctl stop` signals the
wrapper and the core is left to be killed rather than shutting down. The core stops itself
on SIGTERM, which is what systemd sends.

Issues that were mid-flight when it stopped are not lost: their state is on disk and the
next start reattaches to their workspaces.

## 5. Credentials

Corral is BYOK — it stores nothing on your behalf and embeds no keys. There are two ways
to get secrets onto the server.

**From the app (easiest).** Anything you type into the setup wizard while connected to
this core is stored *on the server*, in `$CORRAL_STATE_DIR/credentials.json` (mode 0600).
Nothing needs to be on the server beforehand.

**From the environment.** Useful for CI-ish setups and for secret managers. The variable
name is `CORRAL_<SERVICE>_<ACCOUNT>`, uppercased, where service and account come from that
credential's entry in `corral.yaml`:

```yaml
credential: { service: github, account: server }   # → CORRAL_GITHUB_SERVER
```

Environment wins over the file store, so you can override one secret without touching the
rest.

### ⚠ Provider login on a machine with no browser

This is the step that bites. Pick whichever fits your provider:

- **An API key** — always works headless. Paste it into the wizard, or export it.
- **Capture the login on your laptop.** The wizard's Claude login button runs on *your*
  machine (it opens your browser) and stores the resulting token on the **server's**
  credential store. This is the intended path for subscription logins — the browser stays
  where browsers are.
- **Log in on the server directly**, if the provider's CLI supports a device-code flow you
  can complete over SSH. Then `workspace.docker.mount_host_login: true` mounts that login
  into the containers. Note this mounts the login of whichever machine the *core* runs on —
  on a server, the server's.

## 6. Connect from your laptop

In the Corral desktop app:

**Settings → Core connection → Another computer** → server `you@your-server` → paste the
6-digit code → **Connect**.

That's the whole step. The app opens the SSH tunnel itself and keeps it up for as long as
it is running, so there is no command to leave in a terminal and nothing to open in a
firewall — the connection rides on port 22, which you already use.

After pairing, the app stores a long-lived token in your OS keychain and never needs the
code again. If the tunnel drops — sleep, a network change — the app reopens it and
reconnects. If it *can't*, the connection screen says why (no `ssh` on your machine, the
server refused the key, the local port is taken) instead of just going quiet.

> **Already have a tunnel?** Uncheck **Let Corral open the connection** and give it the
> address directly (`ws://127.0.0.1:4410`). That's the path for an existing tunnel, a VPN,
> or an overlay network like Tailscale.

From here the app behaves exactly as it does locally — except the setup wizard now
configures the server: Docker detection reports the *server's* Docker, secrets land in the
*server's* store, and the agents run there.

## 7. Check it worked

- The app's **Settings → Core connection** shows a green **Connected**
- Docker detection in the wizard reports the server's Docker version, not your laptop's
- `journalctl -u corral -f` shows `control plane client connected`

## Managing devices

```bash
node dist/main.js ~/corral.yaml --pair              # add another laptop
node dist/main.js ~/corral.yaml --revoke laptop     # drop one by label
node dist/main.js ~/corral.yaml --revoke all        # drop every paired device
```

Tokens are stored hashed, so a leaked state directory doesn't hand over a working
credential. A revoked device stops reconnecting immediately and does not retry.

## Troubleshooting

**`EADDRINUSE`** — something already holds 4410. `--control-plane 4411` and tunnel that
port instead.

**The app says "connecting" forever** — the tunnel isn't up, or it points at the wrong
port. `ssh -N -L …` prints nothing when it works; that silence is success.

**Paired, but the wizard won't finish** — the wizard's "test connection" buttons run on
*your laptop*, so they check whether *you* can reach Notion/GitHub, not whether the server
can. If saving then fails, the error you see is the server's — that one is authoritative.

**The core logs `config present but failed to start`** — the config is on disk but couldn't
be built (bad token, unreachable tracker). The core keeps serving so you can fix it from
the app; it does not need a restart.
