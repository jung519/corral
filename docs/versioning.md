# Versioning

Corral ships as **one app** — the desktop shell bundles the core and the renderer — so it
has **one version**. All three `package.json` files (`package.json`, `renderer/`, `desktop/`)
carry the same number, and `app.getVersion()` (what the update gate compares and what the
packaged installer stamps) reads `desktop/package.json`.

## Scheme

[Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- Currently **0.x** — pre-stable. Anything may change; a MINOR bump can break.
- `PATCH` — fixes, no behavior change users must know about.
- `MINOR` — new features / notable changes (breaking allowed while 0.x).
- `MAJOR` — reserved for the 1.0 stability commitment.

## Bumping (single source of truth)

Never edit the three versions by hand — they must stay identical. Use:

```bash
pnpm version:set 0.2.0     # updates all three package.json files
git commit -am "release: v0.2.0"
git tag v0.2.0             # the tag MUST match the version
git push && git push --tags
```

**The git tag `vX.Y.Z` always equals the app version.** The release CI (next milestone)
builds installers from the tag, so a mismatch means the download says one version and the
app reports another.

## The update gate

`version.json` (served at `https://corralhq.dev/version.json`) drives forced/recommended
updates by comparing the running `app.getVersion()`:

- `minSupported` — below it the app is **blocked** until updated (kill switch).
- `recommended` — below it the user gets a **dismissible** nudge.

Raise these numbers as you cut releases. See `desktop/src/update-gate.ts`.
