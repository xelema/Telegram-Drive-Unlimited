#!/usr/bin/env bash
set -euo pipefail

config_root="${XDG_CONFIG_HOME:-${HOME}/.config}"
source_key="${TELEGRAM_DRIVE_ANDROID_KEYSTORE_PATH:-${config_root}/telegram-drive/signing/telegram-drive-release.keystore}"
destination_dir="${1:?Usage: backup-android-signing-key.sh /path/to/encrypted-external-backup}"

test -f "$source_key"
test -d "$destination_dir"

case "$(cd "$destination_dir" && pwd -P)" in
  */TelegramicBackUP_01|*/TelegramicBackUP_01/*)
    echo "Refusing to put the production signing key inside the source repository." >&2
    exit 1
    ;;
esac

umask 077
backup="$destination_dir/telegram-drive-release.keystore"
digest="$destination_dir/telegram-drive-release.keystore.sha256"
if [[ -e "$backup" || -e "$digest" ]]; then
  echo "Backup already exists at the destination; refusing to overwrite it." >&2
  exit 1
fi

cp -p "$source_key" "$backup"
chmod 600 "$backup"
shasum -a 256 "$backup" > "$digest"
chmod 600 "$digest"

echo "Signing-key backup created at $backup"
echo "Store the keystore password separately and repeat this process for a second encrypted/offline destination."
