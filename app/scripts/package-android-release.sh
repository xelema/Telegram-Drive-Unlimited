#!/usr/bin/env bash
set -euo pipefail

build_tools="${ANDROID_HOME:?ANDROID_HOME must be configured}/build-tools/36.0.0"
apksigner="$build_tools/apksigner"
apk="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
aab="src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab"
release_dir="android-release"

abi_apk_path() {
  case "$1" in
    arm64-v8a) printf '%s\n' "src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk" ;;
    armeabi-v7a) printf '%s\n' "src-tauri/gen/android/app/build/outputs/apk/arm/release/app-arm-release.apk" ;;
    x86) printf '%s\n' "src-tauri/gen/android/app/build/outputs/apk/x86/release/app-x86-release.apk" ;;
    x86_64) printf '%s\n' "src-tauri/gen/android/app/build/outputs/apk/x86_64/release/app-x86_64-release.apk" ;;
    *) return 1 ;;
  esac
}

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

for abi in arm64-v8a armeabi-v7a x86 x86_64; do
  abi_apk="$(abi_apk_path "$abi")"
  test -f "$abi_apk"
  abi_signer_output="$($apksigner verify --verbose --print-certs "$abi_apk")"
  abi_fingerprint="$(printf '%s\n' "$abi_signer_output" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1 | tr -d ':[:space:]' | tr '[:lower:]' '[:upper:]')"
  if [ "$abi_fingerprint" != "$expected_fingerprint" ]; then
    echo "Android $abi release certificate does not match the pinned production certificate." >&2
    exit 1
  fi
  unexpected_lib="$(unzip -Z1 "$abi_apk" | sed -n 's#^lib/\([^/]*\)/.*\.so$#\1#p' | sort -u | grep -vx "$abi" || true)"
  if [ -n "$unexpected_lib" ] || ! unzip -Z1 "$abi_apk" | grep -q "^lib/$abi/.*\.so$"; then
    echo "Android $abi APK contains an invalid native-library set." >&2
    exit 1
  fi
done

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
for abi in arm64-v8a armeabi-v7a x86 x86_64; do
  cp "$(abi_apk_path "$abi")" "$release_dir/Telegram-Drive-v${version}-android-${abi}.apk"
done

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
