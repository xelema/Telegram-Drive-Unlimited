# Telegram Drive Privacy Policy

Last updated: August 29, 2026

Telegram Drive is a local-first desktop and Android client. It does not operate a file-storage or Telegram account service and does not sell personal information. The optional supporter feature in supported desktop and Android builds uses a narrowly scoped verification service described below.

## Data stored on your device

Application settings, transfer queues, cached thumbnails and previews, local activity flags, and encrypted vault material are stored locally. Cache controls in Settings can remove cached media without deleting files stored in Telegram.

## Data sent to Telegram

Authentication and file operations connect directly to Telegram using credentials supplied by the user. Folders are represented by private Telegram channels. Telegram receives the messages and file bytes necessary to provide those operations, subject to Telegram's own terms and privacy policy.

The Telegram API hash is stored in the desktop operating-system credential manager or Android Keystore, separately from ordinary JSON settings. A legacy plaintext API hash is retained only until secure migration succeeds. The non-secret API ID and Telegram session database remain in the application's local data directory.

## Crash reporting

Crash reporting is disabled by default and requires explicit consent. A report contains only the application version, operating-system platform, error type, timestamp, and sanitized function names. It excludes error messages, file names, paths, file contents, Telegram messages or identifiers, credentials, phone numbers, and user-entered values. Reporting can be disabled at any time in Settings; disabling it also clears queued reports.

## Sponsored content

Free builds may display clearly labeled sponsor placements. On desktop, the isolated sponsor area first requests the publisher-issued banner loader directly from the advertising provider. As with most browser requests, the provider can receive network and browser context such as the public IP address, user agent, accepted languages, browser client hints, the local sponsor-page referrer origin, and provider cookies when the operating system's WebView privacy settings allow them. If the direct loader is blocked by DNS or the network, the application's loopback fallback requests only the fixed provider loader and forwards the WebView user agent plus allowlisted language/client-hint headers and the local sponsor-page referrer; it never forwards Telegram data or local application cookies. The last validated loader is retained only for outage recovery, and additional creative resources remain inside the isolated sponsor area.

The one-time post-authentication sponsor choice and the Android sponsor placement open an Adsterra Smartlink in the system browser only after the user explicitly chooses it. A non-identifying placement label distinguishes the gateway, Android banner, and desktop failure fallback in publisher statistics. Telegram Drive does not send file activity, file metadata, Telegram credentials, device identifiers, or crash reports to advertising providers. When a sponsor link opens in the system browser, the provider's privacy policy and the browser's own privacy settings apply.

## Local sharing servers

WebDAV, REST, and password-protected local links are disabled until enabled by the user. They listen on the addresses shown in Settings and use capability tokens, API keys, or passwords. Disabling a server or regenerating its credential revokes that access. Guest or anonymous WebDAV connections receive no token-scoped file access.

## Supporter mode

Ad-free access on up to three supported Windows, macOS, Linux, or Android devices in total is activated only after the supporter service verifies one PayPal payment. Telegram Drive does not request or store the purchaser's PayPal email address. The service stores a PayPal order ID and capture ID, payment amount and currency, entitlement status, the accepted supporter-terms version, and cryptographic hashes/public keys used to enforce the shared device limit and refresh access. It does not receive Telegram credentials, phone numbers, file names, file contents, folder information, or application activity.

The device private key, recovery code, and short-lived checkout secret are protected by the platform's secure credential storage, including the desktop operating system credential manager or Android Keystore. A signed entitlement token and non-secret checkout metadata are stored in the application's local data directory. Normal application updates reuse these stable credentials and do not require reactivation.

PayPal processes the payment under PayPal's own terms and privacy policy. Cloudflare processes network requests needed to operate the verification service under Cloudflare's privacy and security terms. Telegram Drive does not add IP addresses or raw PayPal webhook payloads to its D1 entitlement records. Verified PayPal refund and reversal notifications revoke the associated ad-free entitlement. See the [Supporter Terms](SUPPORTER_TERMS.md) for activation, recovery, device-limit, refund, reversal, dispute, availability, and liability conditions.

## User control

Users can clear caches, disable crash reporting, stop local servers, revoke share links, lock the encryption vault, and remove local settings. Files stored in Telegram remain governed by the user's Telegram account until the user deletes them. Payment records that must be retained for fraud prevention, entitlement enforcement, refunds, disputes, accounting, or legal obligations are kept only as long as reasonably necessary for those purposes.

Security reports should not include credentials or private file data. Contact the maintainer through [cameronamer.com](https://www.cameronamer.com) to arrange private disclosure.
