# Telegram Folder Sync

Folder Sync maps a directory on your computer to one Telegram channel. It is disabled by default and remains disabled until you turn on **Settings → Folder Sync → Enable Sync**. That choice is stored in the local application database and is restored when Telegram Drive restarts.

## How synchronization protects your files

Telegram Drive compares three snapshots for every mapping:

1. **Local Tree** — the files currently present in the mapped directory.
2. **Remote Tree** — the documents currently present in the mapped Telegram channel.
3. **Synced Tree** — the last successfully reconciled local and remote state.

The Synced Tree is the safety anchor. A missing remote tree caused by an offline session or network failure is never treated as a set of deletions: reconciliation stops until Telegram can provide a valid remote snapshot. When both the local and remote versions changed since the Synced Tree, Telegram Drive records a conflict instead of overwriting either version.

As an additional guard, a plan that would delete more than half of the Synced Tree is aborted. The files remain untouched, the sync status shows a warning, and the event is written to the sync log.

## Transfer safety and limits

- Telegram folder uploads are capped at exactly **2,000,000,000 bytes**. Larger files stay on your computer and are recorded as skipped; they are never truncated.
- Encrypted files need room for the authenticated TDENC2 envelope, so a plaintext file just below the 2 GB boundary can also be skipped when its encrypted result would exceed Telegram's cap.
- Downloads are written beside the destination as `<filename>.td-sync-tmp`. Telegram Drive verifies and closes the download before atomically renaming it to the requested filename.
- The `.td-sync-tmp` suffix is reserved. If that path already exists, sync preserves it and pauses that download; inspect and remove or rename the stale temp file before retrying.
- Telegram `FLOOD_WAIT` responses pause the queue for the server-requested interval and retry with exponential backoff.
- When a mapping uses vault encryption, uploads pause while the vault is locked and resume after the vault is unlocked.
- A Telegram path that is not representable on every supported desktop filesystem (for example `CON.txt`, a trailing dot, or `report?.pdf`) is rejected rather than silently renamed.
- Each Telegram channel can map to only one local folder, and mapped local folders cannot overlap or be nested.
- Duplicate Telegram messages that resolve to the same relative path pause that pair. Rename or remove the duplicate in Telegram before resuming; the engine never guesses which duplicate should win.
- A mapping pauses if its channel contains more than 50,000 file-bearing messages. This safety ceiling prevents an incomplete remote scan from being mistaken for mass deletion; split very large archives across channels before mapping them.

## Resolve a conflict

The desktop sidebar displays an amber Folder Sync status when conflicts exist. Open the conflict drawer and choose one action for each file:

- **Keep Local** uploads the current computer copy to Telegram.
- **Keep Remote** downloads the Telegram copy and atomically replaces the local file.
- **Keep Both** preserves the local file and downloads the Telegram version with a `.remote-conflict-<id>` suffix.

No conflict is resolved automatically.

## Using WebDAV or the REST API at the same time

WebDAV, the REST API, and Folder Sync all operate against the same Telegram channels. Their changes appear in the Remote Tree during the next reconciliation. Keep these rules in mind:

- Let a WebDAV or REST upload finish before editing the same path locally.
- Simultaneous local and remote edits become an explicit Folder Sync conflict.
- A large remote delete through WebDAV or REST triggers the same mass-deletion protection.
- Encrypted files remain subject to the vault and scoped-credential rules described in the WebDAV and REST API guides.

See [WEBDAV_GUIDE.md](WEBDAV_GUIDE.md) and [REST_API_Documentation.md](REST_API_Documentation.md) for connection and authentication details.
