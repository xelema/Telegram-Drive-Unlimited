#!/usr/bin/env bash
set -euo pipefail

build_tools="${ANDROID_HOME:?ANDROID_HOME must be configured}/build-tools/36.0.0"
apksigner="$build_tools/apksigner"
apk="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
aab="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
release_dir="android-release"

test -x "$apksigner"
test -f "$apk"
test -f "$aab"
test -n "${ANDROID_SIGNING_CERT_SHA256:-}"

signer_output="$($apksigner verify --verbose --print-certs "$apk")"
actual_fingerprint="$(printf '%s\n' "$signer_output" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1 | tr -d ':[:space:]' | tr '[:lower:]' '[:upper:]')"
expected_fingerprint="$(printf '%s' "$ANDROID_SIGNING_CERT_SHA256" | tr -d ':[:space:]' | tr '[:lower:]' '[:upper:]')"

test -n "$actual_fingerprint"
if [ "$actual_fingerprint" != "$expected_fingerprint" ]; then
  echo "Android release certificate does not match the pinned production certificate." >&2
  exit 1
fi

jarsigner -verify -strict "$aab" >/dev/null

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
version_code="$(sed -n 's/^tauri.android.versionCode=//p' src-tauri/gen/android/app/tauri.properties | head -n 1)"
test -n "$version_code"
node scripts/verify-android-release-version.cjs \
  --tag "${GITHUB_REF_NAME:-v${version}}" \
  --generated-properties src-tauri/gen/android/app/tauri.properties

mkdir -p "$release_dir"
cp "$apk" "$release_dir/Telegram-Drive-v${version}-android-universal.apk"
cp "$aab" "$release_dir/Telegram-Drive-v${version}-android-universal.aab"

(
  cd "$release_dir"
  sha256sum Telegram-Drive-* > SHA256SUMS
)

node scripts/create-android-release-manifest.cjs \
  --apk "$release_dir/Telegram-Drive-v${version}-android-universal.apk" \
  --version "$version" \
  --version-code "$version_code" \
  --repository "${GITHUB_REPOSITORY:-caamer20/Telegram-Drive}" \
  --tag "${GITHUB_REF_NAME:-v${version}}" \
  --output "$release_dir/android-update.json"

test -n "${TAURI_PRIVATE_KEY:-}"
npx tauri signer sign "$release_dir/android-update.json"
test -s "$release_dir/android-update.json.sig"
