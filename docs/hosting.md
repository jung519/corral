# Hosting corralhq.dev (GitHub Pages)

`site/` is published to GitHub Pages by `.github/workflows/pages.yml` and served at
**corralhq.dev**:

- `version.json` → the update gate's manifest. Raising `minSupported` here force-updates
  everyone (the kill switch). Edit `site/version.json`, commit → it redeploys automatically.
- `index.html` → the landing page.
- `CNAME` → binds the custom domain.

The app's update gate reads `https://corralhq.dev/version.json`. Until the steps below are
done, that URL 404s — which is harmless: the gate **fails open** (no manifest → app proceeds).

## What only you can do (accounts / DNS)

I can't touch the domain registrar or the repo Settings — those need your accounts.

### 1. Enable Pages (repo Settings)

GitHub → the repo → **Settings → Pages → Build and deployment → Source = "GitHub Actions"**.
(The `pages.yml` deploy job fails until this is set.)

### 2. DNS records (at your domain registrar)

`corralhq.dev` is an **apex** domain, so add four A records (and optionally IPv6 AAAA) to
GitHub Pages' anycast IPs:

| Type | Host | Value |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA (optional) | `@` | `2606:50c0:8000::153` |
| AAAA (optional) | `@` | `2606:50c0:8001::153` |
| AAAA (optional) | `@` | `2606:50c0:8002::153` |
| AAAA (optional) | `@` | `2606:50c0:8003::153` |

(If you also want `www.corralhq.dev`, add a CNAME `www` → `jung519.github.io`.)

### 3. Custom domain + HTTPS (repo Settings)

Settings → Pages → **Custom domain** = `corralhq.dev` (the `site/CNAME` file already sets
this, but confirm it here). Then, once DNS resolves, tick **Enforce HTTPS**.

- **Recommended — verify the domain** (prevents takeover): Settings → Pages → *Verify domains*
  gives you a `TXT` record (`_github-pages-challenge-jung519`) to add at your registrar.
- `.dev` is HTTPS-only (HSTS preload). GitHub provisions a free Let's Encrypt cert once DNS
  points at it — this can take up to ~24h. The gate stays fail-open until then.

## Order

1. Push (this commit) → the Pages workflow runs.
2. Set **Source = GitHub Actions** (step 1) — re-run the workflow if it failed before this.
3. Add the **DNS records** (step 2).
4. Set the **custom domain** + verify + **enable HTTPS** (step 3).
5. Visit `https://corralhq.dev` (landing) and `https://corralhq.dev/version.json` (manifest).

## Updating the manifest (kill switch)

Edit `site/version.json` and push to `main`:

- `minSupported` — apps below this are **blocked** until updated (force).
- `recommended` — apps below this get a **dismissible** nudge.
- `latest` / `downloadUrl` / `notice` — shown to users.

Raise these as you cut releases (keep them in step with the published GitHub Release version).
