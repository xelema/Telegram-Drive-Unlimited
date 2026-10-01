# WebDAV access

Telegram Drive can expose the signed-in account as a local WebDAV drive on the desktop app. The server is disabled by default, binds only to `127.0.0.1`, and uses read-only access unless file changes are explicitly enabled.

WebDAV hosting is supported on macOS, Windows, and Linux. Android and iOS do not start a local WebDAV server.

## Turn on WebDAV

1. Open **Settings** and select the dedicated **WebDAV** tab.
2. Enter a listening port from `1024` through `65535`. The default is `8551`.
3. Leave **Allow file changes** off for read-only access, or enable it after reviewing the warning.
4. Select **Generate** and copy the connection link immediately. The private link is shown only once.
5. Enable the WebDAV server.

The media server port (`14201`) and the port of an enabled REST API cannot be reused. A bind error, including a port already occupied by another program, appears in the WebDAV tab.

The generated URL has this form:

```text
http://127.0.0.1:8551/dav/<private-token>/
```

The app stores only a SHA-256 hash of the token. If the link is lost, regenerate it. Regeneration immediately invalidates the previous link and restarts an enabled WebDAV server.

## Connect a client

Keep Telegram Drive open and signed in while using WebDAV.

### macOS Finder

1. In Finder, choose **Go > Connect to Server**.
2. Paste the complete generated `http://127.0.0.1:...` URL.
3. Choose **Connect**. No separate username or password is required because the private token is part of the URL.

### Windows File Explorer

1. Open **This PC**, open the overflow or context menu, and choose **Add a network location**.
2. Choose a custom network location and paste the complete generated URL.
3. Complete the wizard.

The Windows WebClient service must be available for File Explorer's built-in WebDAV support. A third-party WebDAV client can use the same URL if the Windows network-location wizard is unavailable.

### Linux

Desktop file managers accept the same endpoint with their WebDAV-specific scheme:

- GNOME Files: replace `http://` with `dav://`.
- KDE Dolphin: replace `http://` with `webdav://`.
- Other clients: use the generated HTTP URL unless the client documents a different WebDAV scheme.

## Files and folders

- **Saved Messages** is presented as a top-level folder.
- Telegram Drive channels are presented as the other top-level folders.
- Duplicate or platform-incompatible remote names receive deterministic, Windows-safe display aliases.
- Reads support HTTP byte ranges, so compatible clients can seek within standard media and large files.
- With file changes enabled, clients can upload, rename, copy, move, and delete standard files and can create, rename, or delete folders.
- Uploads are staged in the app cache and sent to Telegram only after the WebDAV PUT completes. Aborted staging files are cleaned up automatically and again at server startup.
- Encrypted files fail closed: WebDAV can list them, but it cannot read, overwrite, rename, move, copy, or delete them.

Telegram remains the backing store, so Telegram service limits, account permissions, bandwidth limits, VPN retry settings, and flood waits still apply. Very large folders may take time to populate on the first WebDAV listing.

## Security

- The server is loopback-only and is not reachable directly from other computers.
- Treat the full generated URL as a password. Any local process or user with the URL has the configured WebDAV access.
- The token is not stored in plaintext and is not written to application logs.
- Read-only mode is recommended unless changes through a WebDAV client are needed.
- WebDAV uses local HTTP because traffic never leaves the computer. Do not expose or forward the port to a LAN or the internet.

## Troubleshooting

- **The client cannot connect:** confirm Telegram Drive is open, signed in, the WebDAV toggle is on, and the status says it is running.
- **The status shows a server error:** select another unused port and press Enter or leave the port field to apply it.
- **A saved link stopped working:** the link was regenerated. Use the newly generated URL.
- **A write fails:** confirm **Allow file changes** is enabled and the target is not an encrypted file.
- **A folder is slow to open:** allow the initial Telegram listing to finish; listings are cached briefly to reduce repeated Telegram requests.
