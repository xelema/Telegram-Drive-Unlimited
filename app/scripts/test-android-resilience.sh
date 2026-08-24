#!/usr/bin/env bash
set -euo pipefail

package_name="${1:-com.cameronamer.telegramdrive}"
scenario="${2:-process-death}"
adb_bin="${ADB:-adb}"

command -v "$adb_bin" >/dev/null
"$adb_bin" get-state >/dev/null

reset_device_state() {
  "$adb_bin" shell dumpsys deviceidle unforce >/dev/null 2>&1 || true
  "$adb_bin" shell dumpsys battery reset >/dev/null 2>&1 || true
}
trap reset_device_state EXIT

launch_app() {
  "$adb_bin" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
}

case "$scenario" in
  process-death)
    launch_app
    "$adb_bin" shell am force-stop "$package_name"
    launch_app
    ;;
  low-battery)
    "$adb_bin" shell dumpsys battery unplug >/dev/null
    "$adb_bin" shell dumpsys battery set level 10 >/dev/null
    launch_app
    ;;
  doze)
    "$adb_bin" shell dumpsys battery unplug >/dev/null
    "$adb_bin" shell dumpsys deviceidle force-idle >/dev/null
    launch_app
    ;;
  reboot-recovery)
    "$adb_bin" reboot
    "$adb_bin" wait-for-device
    launch_app
    ;;
  *)
    echo "Unknown scenario: $scenario (expected process-death, low-battery, doze, or reboot-recovery)" >&2
    exit 2
    ;;
esac

"$adb_bin" shell dumpsys package "$package_name" | grep -E 'versionName=|versionCode=' | head -n 2
echo "Android resilience scenario completed: $scenario"
