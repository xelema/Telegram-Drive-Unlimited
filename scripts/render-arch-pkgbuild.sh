#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <upstream.deb> <version> <output-directory>" >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deb_path="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$2"
output_directory="$3"

if [[ ! -f "${deb_path}" ]]; then
  echo "Debian package not found: ${deb_path}" >&2
  exit 1
fi
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Arch package version must be X.Y.Z, received: ${version}" >&2
  exit 1
fi

expected_name="Telegram.Drive_${version}_amd64.deb"
if [[ "$(basename "${deb_path}")" != "${expected_name}" ]]; then
  echo "Expected ${expected_name}, received $(basename "${deb_path}")" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assets_directory="${repository_root}/packaging/arch"
deb_sha256="$(sha256_file "${deb_path}")"
launcher_sha256="$(sha256_file "${assets_directory}/telegram-drive")"
desktop_sha256="$(sha256_file "${assets_directory}/com.cameronamer.telegramdrive.desktop")"
notice_sha256="$(sha256_file "${assets_directory}/UPSTREAM-LICENSE-NOTICE")"

mkdir -p "${output_directory}"
cp "${deb_path}" "${output_directory}/${expected_name}"
cp "${assets_directory}/telegram-drive" "${output_directory}/telegram-drive"
cp "${assets_directory}/com.cameronamer.telegramdrive.desktop" "${output_directory}/com.cameronamer.telegramdrive.desktop"
cp "${assets_directory}/UPSTREAM-LICENSE-NOTICE" "${output_directory}/UPSTREAM-LICENSE-NOTICE"

sed \
  -e "s/@PKGVER@/${version}/g" \
  -e "s/@DEB_NAME@/${expected_name}/g" \
  -e "s/@DEB_SHA256@/${deb_sha256}/g" \
  -e "s/@LAUNCHER_SHA256@/${launcher_sha256}/g" \
  -e "s/@DESKTOP_SHA256@/${desktop_sha256}/g" \
  -e "s/@NOTICE_SHA256@/${notice_sha256}/g" \
  "${assets_directory}/PKGBUILD.in" > "${output_directory}/PKGBUILD"

if grep -Eq '@[A-Z0-9_]+@|SKIP' "${output_directory}/PKGBUILD"; then
  echo 'Rendered PKGBUILD contains an unresolved token or skipped checksum' >&2
  exit 1
fi

echo "Rendered checksum-locked Arch package recipe in ${output_directory}"
