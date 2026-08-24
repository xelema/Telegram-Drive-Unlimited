#!/usr/bin/env bash
set -euo pipefail

previous_apk="${1:?Usage: verify-android-upgrade.sh PREVIOUS.apk CURRENT.apk}"
current_apk="${2:?Usage: verify-android-upgrade.sh PREVIOUS.apk CURRENT.apk}"
package_name="com.cameronamer.telegramdrive"
build_tools="${ANDROID_HOME:?ANDROID_HOME must be configured}/build-tools/36.0.0"
apksigner="$build_tools/apksigner"
apkanalyzer="${ANDROID_HOME}/cmdline-tools/latest/bin/apkanalyzer"
if [[ ! -x "$apkanalyzer" ]]; then
  apkanalyzer="$(command -v apkanalyzer)"
fi
adb_bin="${ADB:-adb}"

for input in "$previous_apk" "$current_apk"; do
  test -f "$input"
  "$apksigner" verify --verbose "$input" >/dev/null
done

certificate() {
  "$apksigner" verify --print-certs "$1" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n 1 | tr -d ':[:space:]' | tr '[:lower:]' '[:upper:]'
}

previous_certificate="$(certificate "$previous_apk")"
current_certificate="$(certificate "$current_apk")"
test -n "$previous_certificate"
if [[ "$previous_certificate" != "$current_certificate" ]]; then
  echo "Upgrade APKs are signed by different certificates; Android will reject the update." >&2
  exit 1
fi

previous_code="$($apkanalyzer manifest version-code "$previous_apk")"
current_code="$($apkanalyzer manifest version-code "$current_apk")"
if (( current_code <= previous_code )); then
  echo "Current versionCode $current_code must be greater than previous versionCode $previous_code." >&2
  exit 1
fi

"$adb_bin" get-state >/dev/null
"$adb_bin" install -r "$previous_apk" >/dev/null
"$adb_bin" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
"$adb_bin" install -r "$current_apk" >/dev/null

installed_code="$($adb_bin shell dumpsys package "$package_name" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -n 1 | tr -d '\r')"
if [[ "$installed_code" != "$current_code" ]]; then
  echo "Installed versionCode $installed_code does not match expected $current_code." >&2
  exit 1
fi

"$adb_bin" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "In-place Android upgrade passed: $previous_code -> $current_code with certificate $current_certificate"
