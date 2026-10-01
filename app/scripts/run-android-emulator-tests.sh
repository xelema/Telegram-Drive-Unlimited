#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"
if [[ "$PROFILE" != "phone" && "$PROFILE" != "google-tv" && "$PROFILE" != "android-tv" ]]; then
  echo "Usage: $0 <phone|google-tv|android-tv>" >&2
  exit 2
fi

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK_ROOT" ]]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT must point to an Android SDK." >&2
  exit 2
fi

API_LEVEL="${ANDROID_EMULATOR_API:-36}"
ABI="${ANDROID_EMULATOR_ABI:-x86_64}"
RAM_MB="${ANDROID_EMULATOR_RAM_MB:-3072}"
case "$PROFILE" in
  phone)
    IMAGE_TAG="google_apis"
    DEVICE_PROFILE="pixel_2"
    ;;
  google-tv)
    IMAGE_TAG="google-tv"
    DEVICE_PROFILE="tv_1080p"
    ;;
  android-tv)
    IMAGE_TAG="android-tv"
    DEVICE_PROFILE="tv_1080p"
    ;;
esac

SYSTEM_IMAGE="${ANDROID_EMULATOR_IMAGE:-system-images;android-${API_LEVEL};${IMAGE_TAG};${ABI}}"
SYSTEM_IMAGE_DIR="$(printf '%s' "$SYSTEM_IMAGE" | tr ';' '/')"
AVDMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
ADB="$SDK_ROOT/platform-tools/adb"
EMULATOR="$SDK_ROOT/emulator/emulator"
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AVD_NAME="telegram_drive_${PROFILE//-/_}_api_${API_LEVEL//./_}"
TEST_TMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
SIGNED_APK="${ANDROID_SIGNED_APK:-}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$TEST_TMP_ROOT/$AVD_NAME}"
EMULATOR_LOG="$ANDROID_AVD_HOME/emulator.log"
DEVICE_LOG="$ANDROID_AVD_HOME/device-logcat.txt"
SERIAL=""
EMULATOR_PID=""

for executable in "$AVDMANAGER" "$ADB" "$EMULATOR"; do
  if [[ ! -x "$executable" ]]; then
    echo "Required Android SDK executable is missing: $executable" >&2
    exit 2
  fi
done

if [[ ! -d "$SDK_ROOT/$SYSTEM_IMAGE_DIR" ]]; then
  echo "Android emulator image is not installed: $SYSTEM_IMAGE" >&2
  echo "Install it with: sdkmanager '$SYSTEM_IMAGE'" >&2
  exit 2
fi

mkdir -p "$ANDROID_AVD_HOME"
if [[ ! -f "$ANDROID_AVD_HOME/$AVD_NAME.ini" ]]; then
  printf 'no\n' | "$AVDMANAGER" create avd \
    --force \
    --name "$AVD_NAME" \
    --package "$SYSTEM_IMAGE" \
    --device "$DEVICE_PROFILE" >/dev/null
fi

AVD_CONFIG="$ANDROID_AVD_HOME/$AVD_NAME.avd/config.ini"
AVD_CONFIG_TMP="$AVD_CONFIG.telegram-drive.tmp"
awk -v ram="$RAM_MB" '
  BEGIN { updated = 0 }
  /^hw\.ramSize=/ { print "hw.ramSize=" ram; updated = 1; next }
  { print }
  END { if (!updated) print "hw.ramSize=" ram }
' "$AVD_CONFIG" >"$AVD_CONFIG_TMP"
mv "$AVD_CONFIG_TMP" "$AVD_CONFIG"

cleanup() {
  set +e
  if [[ -n "$SERIAL" ]]; then
    "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1
  fi
  if [[ -n "$EMULATOR_PID" ]]; then
    kill "$EMULATOR_PID" >/dev/null 2>&1
    wait "$EMULATOR_PID" >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

"$ADB" start-server >/dev/null
"$EMULATOR" \
  -avd "$AVD_NAME" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -gpu swiftshader_indirect >"$EMULATOR_LOG" 2>&1 &
EMULATOR_PID=$!

for _ in $(seq 1 180); do
  SERIAL="$($ADB devices | awk '$2 == "device" && $1 ~ /^emulator-/ { print $1; exit }')"
  if [[ -n "$SERIAL" ]] && [[ "$($ADB -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
    break
  fi
  if ! kill -0 "$EMULATOR_PID" >/dev/null 2>&1; then
    echo "Android emulator exited before booting. Log follows:" >&2
    tail -200 "$EMULATOR_LOG" >&2
    exit 1
  fi
  sleep 2
done

if [[ -z "$SERIAL" ]] || [[ "$($ADB -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]]; then
  echo "Timed out waiting for the $PROFILE emulator to boot. Log follows:" >&2
  tail -200 "$EMULATOR_LOG" >&2
  exit 1
fi

adb_retry() {
  for _ in $(seq 1 30); do
    if "$ADB" -s "$SERIAL" "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "ADB did not recover while running: adb -s $SERIAL $*" >&2
  return 1
}

adb_retry shell input keyevent 82 || true
adb_retry shell settings put global window_animation_scale 0
adb_retry shell settings put global transition_animation_scale 0
adb_retry shell settings put global animator_duration_scale 0

for native_abi in arm64-v8a armeabi-v7a x86 x86_64; do
  native_library="$APP_ROOT/src-tauri/gen/android/app/src/main/jniLibs/$native_abi/libapp_lib.so"
  if [[ ! -e "$native_library" ]]; then
    echo "Missing prebuilt universal JNI library: $native_library" >&2
    echo "Run the universal Android build before emulator instrumentation." >&2
    exit 1
  fi
done

# The Tauri CLI has already produced and verified the universal JNI libraries.
# Direct Gradle invocations cannot reconnect to the short-lived Tauri build
# WebSocket, so instrumentation reuses those libraries instead of rebuilding.
adb_retry logcat -c
set +e
(
  cd "$APP_ROOT/src-tauri/gen/android"
  ./gradlew :app:connectedUniversalDebugAndroidTest \
    -x :app:rustBuildArm64Debug \
    -x :app:rustBuildArmDebug \
    -x :app:rustBuildUniversalDebug \
    -x :app:rustBuildX86Debug \
    -x :app:rustBuildX86_64Debug \
    --stacktrace
)
TEST_STATUS=$?
set -e

if [[ "$TEST_STATUS" -ne 0 ]]; then
  "$ADB" -s "$SERIAL" logcat -d -v threadtime >"$DEVICE_LOG" 2>&1 || true
  echo "Android instrumentation failed. Fatal device log entries follow:" >&2
  grep -E -i -A 30 -B 5 'FATAL EXCEPTION.*telegram|Process com\.cameronamer|Crash of app com\.cameronamer|lowmemorykiller: Kill .com\.cameronamer|am_crash.*cameronamer|SIGABRT.*telegram|UnsatisfiedLinkError.*telegram|ClassNotFoundException.*telegram' "$DEVICE_LOG" >&2 || true
  echo "Full device log: $DEVICE_LOG" >&2
  exit "$TEST_STATUS"
fi

if [[ -n "$SIGNED_APK" ]]; then
  if [[ ! -f "$SIGNED_APK" ]]; then
    echo "Signed APK smoke-test artifact is missing: $SIGNED_APK" >&2
    exit 1
  fi
  "$ADB" -s "$SERIAL" uninstall com.cameronamer.telegramdrive >/dev/null 2>&1 || true
  adb_retry install "$SIGNED_APK"
  adb_retry logcat -c
  "$ADB" -s "$SERIAL" shell am start -W \
    -a android.intent.action.MAIN \
    -c android.intent.category.LEANBACK_LAUNCHER \
    -n com.cameronamer.telegramdrive/.MainActivity >/dev/null
  sleep 8
  if [[ -z "$($ADB -s "$SERIAL" shell pidof com.cameronamer.telegramdrive 2>/dev/null | tr -d '\r')" ]]; then
    "$ADB" -s "$SERIAL" logcat -d -v threadtime >"$DEVICE_LOG" 2>&1 || true
    echo "The production-signed APK did not remain running after TV launch." >&2
    grep -E -i -A 30 -B 5 'FATAL EXCEPTION.*telegram|Process com\.cameronamer|UnsatisfiedLinkError|ClassNotFoundException' "$DEVICE_LOG" >&2 || true
    exit 1
  fi
  echo "Production-signed APK installed and launched through the Leanback entry point."
fi

echo "Android instrumentation passed on $PROFILE ($SERIAL, API $API_LEVEL)."
