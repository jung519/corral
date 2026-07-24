# Code signing & notarization

Signing removes the scary launch warnings: macOS **Gatekeeper** ("Corral can't be opened
because it is from an unidentified developer") and Windows **SmartScreen** ("Windows
protected your PC"). Until it's set up, installers are **unsigned** — they still work, but
users must bypass the warning by hand (see [Bypassing while unsigned](#bypassing-while-unsigned)).

## What's automated vs. what only you can do

The release CI (`.github/workflows/release.yml`) is **already wired to sign and notarize** —
but only when the certificates exist as GitHub secrets. It is **safe when the secrets are
absent**: builds just stay unsigned. No code change is needed to turn signing on.

The certificates themselves **cannot be automated** — they require paid accounts, legal
identity verification, and payment that only you can complete. This page is that runbook.

---

## macOS (Apple Developer ID + notarization)

1. **Enroll** in the [Apple Developer Program](https://developer.apple.com/programs/) — $99/year.
2. **Create a "Developer ID Application" certificate.** Easiest in Xcode:
   *Settings → Accounts → (your team) → Manage Certificates → ＋ → Developer ID Application*.
   It lands in your login keychain.
3. **Export it as `.p12`:** Keychain Access → right-click the "Developer ID Application" cert
   → *Export* → `.p12`, and set an export password (you'll need it below).
4. **Base64-encode it** for the secret:
   ```bash
   base64 -i Certificates.p12 | pbcopy
   ```
5. **App-specific password** (for notarization): [appleid.apple.com](https://appleid.apple.com)
   → *Sign-In & Security → App-Specific Passwords* → generate one (label it "corral notarize").
6. **Team ID:** developer.apple.com → *Membership* (a 10-character ID).
7. **Add these repository secrets** (GitHub → *Settings → Secrets and variables → Actions*):

   | Secret | Value |
   |---|---|
   | `MAC_CSC_LINK` | the base64 `.p12` from step 4 |
   | `MAC_CSC_KEY_PASSWORD` | the `.p12` export password from step 3 |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 5 |
   | `APPLE_TEAM_ID` | the 10-char Team ID from step 6 |

   ⚠️ **All-or-nothing:** the workflow only enables the Apple notary creds when `MAC_CSC_LINK`
   is also set (notarizing an *unsigned* app fails). Add the cert and the notary secrets
   together. If you add the cert but skip the notary secrets, builds are **signed but not
   notarized** — that still trips Gatekeeper, so add all five.

That's it. The next tagged release signs with the cert and notarizes via `APPLE_*`
automatically — electron-builder reads these env vars; no config edit needed.

---

## Windows (code-signing certificate)

1. **Get a code-signing certificate:**
   - **OV** (Organization Validation, ~$100–400/yr from Sectigo, DigiCert, SSL.com, …) —
     cheaper, but SmartScreen reputation builds up over downloads, so early users may still
     see a warning.
   - **EV** (Extended Validation) — clears SmartScreen fastest, but pricier and issued on a
     hardware token / cloud HSM.
2. **Export to `.pfx`** with a password, then base64-encode:
   ```bash
   base64 -i cert.pfx        # macOS/Linux
   # Windows PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))
   ```
3. **Add repository secrets:**

   | Secret | Value |
   |---|---|
   | `WIN_CSC_LINK` | the base64 `.pfx` |
   | `WIN_CSC_KEY_PASSWORD` | the `.pfx` password |

   ⚠️ **Cloud/HSM certs:** many modern OV/EV certs are non-exportable (key lives on a token or
   in Azure). Those can't be used as a `.pfx` secret — they need a different signer (e.g.
   **Azure Trusted Signing** or `signtool` with the token). If that's your cert, tell me and
   we'll wire that path instead.

---

## Verify

After adding the secrets, cut a release (`git tag vX.Y.Z && git push --follow-tags`), download
the draft-release artifacts, and confirm:

- **macOS:** the `.dmg` opens and the app launches with no "unidentified developer" prompt.
- **Windows:** the installer runs without SmartScreen blocking it (EV) or with a "More info →
  Run anyway" that disappears as reputation builds (OV).

## Bypassing while unsigned

Share this with early testers until signing is live:

- **macOS:** right-click the app → **Open** (or *System Settings → Privacy & Security → Open
  Anyway*). Only needed the first time.
- **Windows:** on the SmartScreen dialog, **More info → Run anyway**.

## Security

These secrets are private keys — GitHub encrypts them and never exposes them in logs. Never
commit a `.p12` / `.pfx` to the repo. Rotate them if they leak.
