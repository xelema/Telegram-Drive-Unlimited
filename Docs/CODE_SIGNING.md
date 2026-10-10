# Desktop Code Signing

The release workflow signs and notarizes desktop builds when signing credentials are present in the repository settings. When they are absent, the workflow prints a warning and produces the same unsigned builds as before. A platform with only some of its values set fails the release instead of publishing a build that is signed but not notarized.

Signing changes only the code signature. The bundle identifier `com.cameronamer.telegramdrive`, the updater key, the supporter credential service and account names, the entitlement token format, and the supporter service are not affected.

## macOS: Developer ID and notarization

Requires an Apple Developer Program membership.

| Setting | Kind | Value |
| :--- | :--- | :--- |
| `APPLE_CERTIFICATE` | Secret | Base64 of the exported Developer ID Application certificate (`.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Secret | Password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Secret | For example `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | Secret | App Store Connect API issuer ID |
| `APPLE_API_KEY` | Secret | App Store Connect API key ID |
| `APPLE_API_KEY_P8` | Secret | Contents of the `AuthKey_<key id>.p8` file |

The build signs with the hardened runtime and the existing `entitlements.plist`, submits the application for notarization, and staples the ticket. A later step fails the release unless `codesign --verify`, `stapler validate`, and Gatekeeper assessment all accept the application and its identifier is unchanged.

## Windows: Azure Artifact Signing

Requires an Azure Artifact Signing (formerly Trusted Signing) account with a certificate profile, and an app registration that has the certificate profile signer role. The workflow installs `artifact-signing-cli` 0.11.0, which calls `signtool` on the runner.

| Setting | Kind | Value |
| :--- | :--- | :--- |
| `AZURE_CLIENT_ID` | Secret | App registration client ID |
| `AZURE_CLIENT_SECRET` | Secret | App registration client secret |
| `AZURE_TENANT_ID` | Secret | Directory (tenant) ID |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Variable | For example `https://eus.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Variable | Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | Variable | Certificate profile name |

The application executable and the installer are signed and timestamped. A later step fails the release unless both carry a valid, timestamped Authenticode signature. An OV or EV certificate held on a hardware token cannot be used from a hosted runner; it needs a different sign command.

## First signed release: required acceptance

Run these on real machines before publishing the first signed release. They are not automated.

1. **Update from the last unsigned release.** Install the previous release, sign in, then update in the app. The session, settings, encryption vault, and folder layout must be unchanged.
2. **Supporter activation survives the update.** On a machine with an active $5 lifetime activation, update and confirm the supporter status is still active and no sponsor placement appears. On macOS the first signed build has a new code identity, so the system may ask once for permission to read the existing Keychain items.
   - Choosing **Always Allow** must restore the activation with no further prompts.
   - Choosing **Deny**, or dismissing the prompt, must not show advertisements or a purchase prompt to an existing purchaser. The stored entitlement token still verifies without the Keychain; only refresh and recovery-code display need it.
   - If either case fails, do not publish. Existing purchasers must never be asked to pay again.
3. **Recovery code.** Restore the activation with its recovery code on a second machine running the signed build.
4. **Gatekeeper and SmartScreen.** Download the published artifacts with a browser on a clean machine and open them. macOS must open the application without the unidentified-developer dialog. Windows SmartScreen reputation builds over time; record what is shown.

## Rehearsal

These workflow steps have not been run with real credentials. Before the first public signed release, push a pre-release tag to a private fork that has the credentials and confirm that the signing step and the two verification steps pass.
