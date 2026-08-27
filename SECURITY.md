# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security advisories) on this repository, rather than opening a public issue.
Include steps to reproduce and the impact. We aim to acknowledge reports promptly.

## Security model

- **BYOK (bring your own keys).** Corral embeds no provider credentials. All
  tokens/keys are supplied by the user.
- **Secrets at rest.** Never in the config file. In the desktop app they go to the
  OS keychain via Electron `safeStorage` (`desktop/src/keychain.ts`). The headless
  core layers two sources: `CORRAL_*` environment variables, which are read-only and
  take precedence, and `<state dir>/credentials.json`, written with mode `0600` —
  that file is where a value saved headlessly is kept, so treat the state directory
  as sensitive.
- **Config holds references, not secrets.** `corral.yaml` contains only
  `CredentialRef` pointers (service + account), never the secret values.
- **No bundled proprietary binaries.** Provider CLIs are detected on the host and
  invoked; they are never redistributed.
- **Compliance is the user's responsibility.** Each provider's terms of service
  govern use of their APIs/CLIs with your own credentials.

## Handling tokens

When filing a bug, never paste tokens, API keys, or full clone URLs (which embed
tokens). Logs may contain redacted URLs — verify before sharing.
