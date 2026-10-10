# Release notes template

Replace VERSION and filenames with the actual release. Use the reviewed first changelog block and distinguish local E2E evidence from installed/device acceptance. State whether this is a rehearsal prerelease or a stable release. Prereleases are never latest and are not offered by the stable updater.

## Verify downloaded artifacts

Download the artifact and `SHA256SUMS.txt` from the same release. On Linux run `sha256sum -c SHA256SUMS.txt`; on macOS use `shasum -a 256` for the selected file; on Windows use `Get-FileHash -Algorithm SHA256` and compare the matching manifest entry. Checksums detect corruption; provenance verifies the producing repository/workflow.

```sh
gh attestation verify ./DOWNLOADED_ARTIFACT --repo caamer20/Telegram-Drive
```

Require a successful verification for the expected repository and inspect the reported release workflow/ref against the tag you downloaded. Do not install on a failed or unexpected verification. Source CycloneDX SBOM, Arch runtime SBOM and Sigstore bundles accompany the checksums. Verification needs a current GitHub CLI with attestation support and network access; no verification is claimed until run.

## Compatibility and acceptance

TDENC2 is a frozen-format beta; independent cryptographic review remains pending. Every feature remains free. The optional one-time $5.00 USD lifetime ad-free supporter entitlement, three-device allowance and recovery codes remain compatible. Link the [acceptance runbook](RELEASE_ACCEPTANCE.md) and record actual executed platforms rather than implying all platforms passed.

Rehearsal packaging retains the plain base application version: tag `vX.Y.Z-rc.N` uses application/changelog `X.Y.Z`, so DMG, NSIS, Debian and Arch inputs keep the existing plain-version shape. The same-version final installer must be installed manually in the isolated rehearsal profile. Suffix-version acceptance by the real macOS/NSIS bundlers is UNRUN; this policy avoids requiring it. Never mirror rehearsal `latest.json` to the stable website endpoint.

Packaged startup smoke is restricted to disposable OS users/VMs. It uses a unique runtime Tauri identifier and validates actual resolved profile paths before native initialization; environment variables alone do not redirect OS known folders or keyrings. The private token/PID/profile marker is written by the existing frontend-to-native startup-health request only after database, app-data and streaming readiness. Fixture launcher tests do not count as packaged OS acceptance.
