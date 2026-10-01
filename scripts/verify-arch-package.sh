#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <package.pkg.tar.zst> <version>" >&2
  exit 2
fi

package_path="$1"
version="$2"
if [[ ! -f "${package_path}" ]]; then
  echo "Arch package not found: ${package_path}" >&2
  exit 1
fi

package_info="$(bsdtar -xOf "${package_path}" .PKGINFO)"
package_files="$(bsdtar -tf "${package_path}")"

assert_info() {
  if ! grep -Fqx "$1" <<<"${package_info}"; then
    echo "Missing package metadata: $1" >&2
    exit 1
  fi
}

assert_file() {
  if ! grep -Fqx "$1" <<<"${package_files}"; then
    echo "Missing packaged file: $1" >&2
    exit 1
  fi
}

assert_info 'pkgname = telegram-drive-bin'
assert_info "pkgver = ${version}-1"
assert_info 'arch = x86_64'
for dependency in cairo dbus gdk-pixbuf2 glib2 glibc gtk3 libayatana-appindicator libgcc libsoup3 libstdc++ webkit2gtk-4.1; do
  assert_info "depend = ${dependency}"
done

assert_file 'usr/bin/telegram-drive'
assert_file 'usr/lib/telegram-drive/app'
assert_file 'usr/share/applications/com.cameronamer.telegramdrive.desktop'
assert_file 'usr/share/licenses/telegram-drive-bin/UPSTREAM-LICENSE-NOTICE'

if grep -Eq '^(home|root)/|/\.config/|/\.local/share/' <<<"${package_files}"; then
  echo 'The package must not contain user data or home-directory files' >&2
  exit 1
fi
if grep -Fqx 'usr/bin/app' <<<"${package_files}"; then
  echo 'The generic upstream /usr/bin/app path must not remain in the Arch package' >&2
  exit 1
fi

temporary_root="$(mktemp -d)"
trap 'rm -rf "${temporary_root}"' EXIT
bsdtar -xf "${package_path}" -C "${temporary_root}"

sh -n "${temporary_root}/usr/bin/telegram-drive"
grep -Fq 'TELEGRAM_DRIVE_PACKAGE_MANAGER=pacman' "${temporary_root}/usr/bin/telegram-drive"
grep -Fqx 'Exec=telegram-drive' "${temporary_root}/usr/share/applications/com.cameronamer.telegramdrive.desktop"
grep -Fqx 'Icon=com.cameronamer.telegramdrive' "${temporary_root}/usr/share/applications/com.cameronamer.telegramdrive.desktop"
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "${temporary_root}/usr/share/applications/com.cameronamer.telegramdrive.desktop"
fi
file "${temporary_root}/usr/lib/telegram-drive/app" | grep -Fq 'ELF 64-bit'

if command -v ldd >/dev/null 2>&1; then
  ldd_output="$(ldd "${temporary_root}/usr/lib/telegram-drive/app")"
  if grep -Fq 'not found' <<<"${ldd_output}"; then
    printf '%s\n' "${ldd_output}" >&2
    exit 1
  fi
fi

echo "Verified telegram-drive-bin ${version}-1"
