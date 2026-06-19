## What

Briefly describe the change.

## Why

The motivation / issue it addresses.

## How verified

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] (if renderer) `pnpm -C renderer build`
- [ ] (if desktop) `pnpm -C desktop build`
- Manual verification:

## Notes

- [ ] No secrets in config (only `CredentialRef`)
- [ ] No project/language-specific values added to the core `src/`
- [ ] No proprietary binaries bundled
