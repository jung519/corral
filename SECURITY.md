# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security advisories) on this repository, rather than opening a public issue.
Include steps to reproduce and the impact. We aim to acknowledge reports promptly.

## Security model

- **BYOK (bring your own keys).** Corral embeds no provider credentials. All
  tokens/keys are supplied by the user.
- **Secrets at rest.** In the desktop app, secrets are stored in the OS keychain
  via Electron `safeStorage` (`desktop/src/keychain.ts`), never in the config file.
  In headless use, secrets come from `CORRAL_*` environment variables.
- **Config holds references, not secrets.** `corral.yaml` contains only
  `CredentialRef` pointers (service + account), never the secret values.
- **No bundled proprietary binaries.** Provider CLIs are detected on the host and
  invoked; they are never redistributed.
- **Compliance is the user's responsibility.** Each provider's terms of service
  govern use of their APIs/CLIs with your own credentials.

## Handling tokens

When filing a bug, never paste tokens, API keys, or full clone URLs (which embed
tokens). Logs may contain redacted URLs — verify before sharing.
