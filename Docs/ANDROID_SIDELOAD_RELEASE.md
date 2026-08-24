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
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs Telegram-Drive-v3.5.0-android-universal.apk
```

Never change the package name or signing key for an update. Android accepts an in-place upgrade only when both remain stable and the new `versionCode` is greater.

## Protected CI values

Configure these GitHub Actions secrets before creating a release tag:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_SIGNING_CERT_SHA256` (certificate fingerprint, not keystore file hash)
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the updater key is encrypted

The production workflow fails closed if Android signing, updater signing, or the pinned certificate is absent. Pull requests may compile unsigned artifacts for validation, but the workflow does not publish them.

## Build and release

1. Update the same semantic version in `app/package.json`, `app/src-tauri/Cargo.toml`, and `app/src-tauri/tauri.conf.json`.
2. Run `npm run android:version:check -- --tag vX.Y.Z` from `app/`.
3. Run the frontend and Rust tests.
4. Reproduce the generated Android project and build the universal APK/AAB.
5. Run the JNI/R8, four-ABI, 16 KB alignment, certificate, checksum, and generated-update-manifest gates.
6. Push `vX.Y.Z`. The release workflow publishes only after the signed Android and desktop jobs pass.

The release includes:

- `Telegram-Drive-vX.Y.Z-android-universal.apk`
- `Telegram-Drive-vX.Y.Z-android-universal.aab` (archival/device-management use)
- `SHA256SUMS`
- `android-update.json`
- `android-update.json.sig`

The in-app Android updater verifies the embedded Minisign key, exact package name, GitHub release URL, monotonically newer `versionCode`, APK filename, size limit, and SHA-256 before opening Android's trusted package installer. Users may need to grant “Install unknown apps” permission to Telegram Drive once.

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

The emulator runner creates an isolated AVD and requires the matching API 36 system image. Android CI installs and tests both the phone and Google TV images. The resilience script changes emulator/device power state and resets it on exit. Use `reboot-recovery` only on a dedicated test device.

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
