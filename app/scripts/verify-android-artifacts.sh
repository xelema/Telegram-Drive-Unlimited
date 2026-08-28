#!/usr/bin/env bash
set -euo pipefail

artifact_root="${1:-src-tauri/gen/android/app/build/outputs}"
android_sdk="${ANDROID_HOME:?ANDROID_HOME is required}"
apk_path=""
aab_path=""

for candidate in \
  "$artifact_root/apk/universal/release/app-universal-release.apk" \
  "$artifact_root/apk/universal/release/app-universal-release-unsigned.apk"; do
  if [[ -f "$candidate" ]]; then
    apk_path="$candidate"
    break
  fi
done

if [[ -z "$apk_path" ]]; then
  apk_path="$(find "$artifact_root" -type f -name '*.apk' \
    ! -path '*/androidTest/*' ! -path '*/debug/*' -print -quit)"
fi

for candidate in \
  "$artifact_root/bundle/universalRelease/app-universal-release.aab" \
  "$artifact_root/bundle/universalRelease/app-universal-release-unsigned.aab"; do
  if [[ -f "$candidate" ]]; then
    aab_path="$candidate"
    break
  fi
done

if [[ -z "$aab_path" ]]; then
  aab_path="$(find "$artifact_root" -type f -name '*.aab' ! -path '*/debug/*' -print -quit)"
fi

if [[ -z "$apk_path" || -z "$aab_path" ]]; then
  echo "Expected both APK and AAB outputs under $artifact_root" >&2
  exit 1
fi

abis=(arm64-v8a armeabi-v7a x86 x86_64)
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
unzip -Z1 "$apk_path" > "$temp_dir/apk-entries.txt"
unzip -Z1 "$aab_path" > "$temp_dir/aab-entries.txt"

grep -Eq '(^|/)baseline\.prof$' "$temp_dir/apk-entries.txt" || {
  echo "APK is missing the compiled Baseline Profile." >&2
  exit 1
}

for abi in "${abis[@]}"; do
  grep -q "lib/$abi/.*\.so" "$temp_dir/apk-entries.txt" || {
    echo "APK is missing native libraries for $abi" >&2
    exit 1
  }
  grep -q "lib/$abi/.*\.so" "$temp_dir/aab-entries.txt" || {
    echo "AAB is missing native libraries for $abi" >&2
    exit 1
  }
done

unzip -q "$apk_path" 'lib/*/*.so' -d "$temp_dir"

readelf_path="${READELF:-}"
if [[ -z "$readelf_path" ]] && command -v readelf >/dev/null 2>&1; then
  readelf_path="$(command -v readelf)"
fi
if [[ -z "$readelf_path" ]]; then
  readelf_path="$(find "$android_sdk/ndk" -name llvm-readelf -print | sort -V | tail -n 1)"
fi
if [[ -z "$readelf_path" || ! -x "$readelf_path" ]]; then
  echo "Unable to locate readelf or the Android NDK llvm-readelf." >&2
  exit 1
fi

for abi in arm64-v8a x86_64; do
  while IFS= read -r library; do
    while IFS= read -r alignment; do
      if (( alignment < 0x4000 )); then
        echo "$library has LOAD alignment $alignment; expected at least 0x4000" >&2
        exit 1
      fi
    done < <("$readelf_path" -lW "$library" | awk '$1 == "LOAD" { print $NF }')
  done < <(find "$temp_dir/lib/$abi" -type f -name '*.so')
done

zipalign_path="$(find "$android_sdk/build-tools" -type f -name zipalign | sort -V | tail -n 1)"
"$zipalign_path" -c -P 16 -v 4 "$apk_path" >/dev/null

echo "Android artifacts contain all four ABIs and pass 16 KB ELF/ZIP alignment checks."
