# Android and Google TV sideload release runbook

Telegram Drive is distributed as a signed sideloaded Android application, not through Google Play. The same universal APK supports Android phones, tablets, Android TV, and Google TV.

## Fixed application identity

- Package name: `com.cameronamer.telegramdrive`
- Minimum Android version: Android 7.0 / API 24
- Target SDK: API 36
- Release keystore: `${XDG_CONFIG_HOME:-$HOME/.config}/telegram-drive/signing/telegram-drive-release.keystore`
- Key alias: `telegram-drive`
- Keystore file SHA-256 as of 2026-08-23: `b937e396837de9600325774564d45ee1502f55fbc2a6684476829be19742506c`

The keystore-file SHA-256 is only a backup-integrity checksum. It is **not** the Android signing-certificate fingerprint. Obtain the certificate fingerprint from a signed APK with:

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs Telegram-Drive-vX.Y.Z-android-universal.apk
```

Never change the package name or signing key for an update. Android accepts an in-place upgrade only when both remain stable and the new `versionCode` is greater.

## Android builds are local

Android is built, signed, and verified on the maintainer's machine. No GitHub workflow builds Android, and the Android project, build configuration, generated project folders, and Android test projects are never committed or uploaded. Only the compiled, signed binaries are published, as assets of the separate Android release.

Provide these values to the local build through the environment, never through a tracked file:

- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_SIGNING_CERT_SHA256` (certificate fingerprint, not keystore file hash)
- `TAURI_PRIVATE_KEY` (the local packaging signer input)
- `TAURI_KEY_PASSWORD` when the updater key is encrypted

The packaging scripts fail closed if Android signing, updater signing, or the pinned certificate is absent.

## Local build and binary publication

Status: all Android builds, artifact verification and installed-device acceptance for this tree are UNRUN. The desktop workflow is not Android verification. The version-line decision belongs to the owner; do not change shared desktop versions merely to follow this runbook.

1. On the maintainer's private machine, use the reviewed release commit, Node 22, Rust 1.92, Java/Android SDK/NDK required by the local project, and the existing signing identity. Keep the generated Android project and all credentials outside outgoing Git commits. Choose the Android release version/code only after the owner decides the version line; verify the relevant inputs with `npm run android:version:check -- --tag vX.Y.Z` from `app/`.
2. Run the host gates in `TESTING.md`. In `app/`, run `npm ci`, `npm run build:verify`, then the established local Android generation/build command `npm run tauri -- android build`. Preserve the locally maintained Android configuration; no Android project is created in GitHub. Confirm universal APK/AAB and the four ABI-specific signed APK outputs exist before packaging.
3. From `app/`, run `bash scripts/verify-android-artifacts.sh src-tauri/gen/android/app/build/outputs`. This checks Baseline Profile presence, all four ABIs and 16 KiB ELF/ZIP alignment. Run `bash scripts/package-android-release.sh` with the existing private signing environment and pinned `ANDROID_SIGNING_CERT_SHA256`. It verifies certificates and AAB signing, packages binaries, creates `SHA256SUMS`, and creates/signs `android-update.json`. Preserve the APK hash, versionCode, package name, update-manifest URL and source revision in the private acceptance log. Do not publish signing keys.
4. On a dedicated device with the previous signed APK installed, sign in, activate an existing supporter recovery code, create a test folder and transfer queue, and record data/activation visibly before upgrade. Run `bash scripts/verify-android-upgrade.sh /private/path/previous.apk /private/path/current.apk` from `app/`. It checks matching certificates, increasing versionCode, in-place install and launch. It does **not** itself inspect application data or supporter state. After it finishes, check that the Telegram session, folder/queue, recovery code and active ad-free entitlement survived with no purchase prompt. Repeat on phone and TV. Any data/activation loss blocks publication.
5. Complete the device matrix below and [release acceptance](RELEASE_ACCEPTANCE.md). Verify `android-update.json` identifies the exact package, monotonically newer code, APK filename, SHA-256 and separate Android release URL; verify its Minisign signature with the existing embedded public key. Compare `SHA256SUMS` against the final APK bytes, not an earlier build.
6. Before any GitHub push, run `node scripts/check-android-publication.cjs --range BASE..HEAD` at the repository root, replacing BASE with the remote published revision, and manually inspect `git diff --name-status BASE..HEAD` and every outgoing commit. The guard's pending owner-review list is not permission to publish those paths. Android project/configuration/generated/test sources and signing files must never be pushed, even if a later outgoing commit removes them.
7. Only after owner authorization and every local gate passes, create/use the separate Android release and upload the compiled signed APKs and their checksums/update manifest/signature. Keep the AAB as a private archive unless separately authorized as a compiled release asset. Never upload source folders, Gradle reports containing private paths, projects, credentials or signing backups. Do not push a desktop version tag as part of Android publication.

The updater metadata is derived from the exact universal APK, using `scripts/create-android-release-manifest.cjs` (arguments `--apk`, `--version`, `--version-code`, `--repository`, `--tag`, `--output`) and the existing updater signing key. Use the real separate Android tag in the final manifest. Local packaging/version verification may use the plain semantic tag required by its checker; inspect the final download URL before signing rather than assuming it is correct for an `Androidv...` tag. Publication and key changes are owner actions, not performed by this pass.

## Android and TV advertising

Free Android phone, tablet, Android TV, and Google TV users receive the app's remote-focusable sponsored placement. Its action uses the production Adsterra campaign URL defined in `src/services/sponsorLinks.ts`. Verified lifetime supporters remain ad-free. The placement is automatically suppressed during media playback, previews, dialogs, and active transfers so it does not cover controls or compete with streaming bandwidth.

Do not add Google Mobile Ads or an AdMob application ID to the television package. Google Mobile Ads does not support Android TV; Telegram Drive's Android/TV advertising path is the in-app Adsterra placement.

## Phone, tablet, and television acceptance

Use at least one API 24–28 phone-class device, one API 35 phone/tablet, and one API 35 Android TV or Google TV device/emulator. Verify:

- cold sign-in and session restoration;
- D-pad focus, Select/Enter activation, Back navigation, Leanback launcher banner, and landscape layout on TV;
- remote-friendly file browsing, settings, transfer controls, and in-app media playback;
- the remote-focusable in-app sponsor placement for free users on TV, its supporter/ad-free suppression, and its automatic suppression during playback, previews, dialogs, and active transfers;
- audio/video streaming without leaving Telegram Drive, system MediaSession controls, seek/resume, playback speed, subtitle/audio track selection, and Picture-in-Picture where supported;
- Wi-Fi/metered/roaming, low-battery, charging, Doze, process-death, reboot, and low-storage transfer behavior;
- notification denial and recovery, app lock, screenshot/Recents protection, and private lock-screen media metadata;
- install-over-existing upgrade without clearing app data.

Useful test commands:

```bash
bash scripts/run-android-emulator-tests.sh phone
bash scripts/run-android-emulator-tests.sh google-tv
bash scripts/test-android-resilience.sh com.cameronamer.telegramdrive process-death
bash scripts/test-android-resilience.sh com.cameronamer.telegramdrive low-battery
bash scripts/test-android-resilience.sh com.cameronamer.telegramdrive doze
bash scripts/verify-android-upgrade.sh previous.apk current.apk
```

The emulator runner creates an isolated AVD and requires the matching API 36 system image. Run it for both the phone and Google TV images. The resilience script changes emulator/device power state and resets it on exit. Use `reboot-recovery` only on a dedicated test device.

## Sideloading

On Android phones/tablets, download the signed universal APK from the matching GitHub release, compare it with `SHA256SUMS`, allow the browser/file manager to install unknown apps, and open the APK.

On Android TV or Google TV, either transfer the APK with a trusted local file-transfer tool or install it through ADB:

```bash
adb install Telegram-Drive-vX.Y.Z-android-universal.apk
```

For an upgrade, use `adb install -r ...` or the in-app updater. Never uninstall first unless intentionally deleting the device's local Telegram Drive data.

## Signing-key recovery

The production key exists and is permission-restricted (`0600`). Create two independent encrypted/offline backups; do not put either in Git, cloud-sync folders without client-side encryption, issue trackers, or chat:

```bash
bash app/scripts/backup-android-signing-key.sh /Volumes/EncryptedBackup/TelegramDrive
```

Store the keystore password separately from both key copies. Test one backup by comparing the `.sha256` file and listing its alias in an offline environment. Losing either the key or its password permanently prevents normal in-place updates to installed copies.

## Android developer verification

Because the app is sideloaded, the owner should register the package and signing certificate in Android Developer Console using the same legal developer identity and release certificate. This is an authenticated external-account action and cannot be completed by repository automation. Record the completed registration and certificate fingerprint in the private release-operations log; do not store identity documents or keystore passwords in this repository.
