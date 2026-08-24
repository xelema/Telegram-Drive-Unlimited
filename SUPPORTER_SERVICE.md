# Supporter Verification Service

The desktop supporter feature is backed by a Cloudflare Worker, D1, and PayPal Orders v2. The service verifies payment before issuing an Ed25519-signed entitlement bound to a desktop device key. It deliberately does not request or store purchaser email addresses.

## Security and privacy model

- PayPal credentials, the webhook ID, the Ed25519 private JWK, and recovery-code keys are Cloudflare Worker secrets and must never be committed or placed in GitHub variables.
- The desktop app embeds only the public Ed25519 verification key and public service URL.
- Device private keys, recovery codes, and short-lived checkout secrets use macOS Keychain, Windows Credential Manager, or Linux Secret Service under the stable service name `com.cameronamer.telegramdrive.supporter`.
- Signed tokens are valid for 30 days with a seven-day offline grace period. The app attempts a refresh on startup, so a verified refund or reversal takes effect when the service is reachable.
- PayPal webhook signatures are verified through PayPal before events are processed. Event IDs are deduplicated, and failed processing remains retryable.
- Checkout creation records the exact supporter-terms version and acceptance timestamp before redirecting to PayPal.
- A scheduled GitHub Action writes checksum-protected, restore-ready D1 SQL exports to a private R2 bucket; see [Supporter D1 Backup and Recovery](SUPPORTER_BACKUP_RECOVERY.md).

## Local verification

From `supporter-service/`:

```bash
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

## Required Cloudflare configuration

Create or select the D1 database named `telegram-drive-supporter`, apply `migrations/0001_initial.sql`, and set these Worker secrets:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_MERCHANT_ID`
- `PAYPAL_WEBHOOK_ID`
- `PUBLIC_ORIGIN` — the final HTTPS Worker/custom-domain origin with no trailing slash
- `ENTITLEMENT_SIGNING_JWK` — an Ed25519 private JWK containing `kty`, `crv`, `x`, and `d`
- `RECOVERY_LOOKUP_KEY` — at least 32 random bytes encoded with unpadded base64url
- `RECOVERY_ENCRYPTION_KEY` — exactly 32 random bytes encoded with unpadded base64url

Configure PayPal to send these events to `<PUBLIC_ORIGIN>/v1/paypal/webhook`:

- `CHECKOUT.ORDER.APPROVED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `CUSTOMER.DISPUTE.RESOLVED`

Use PayPal sandbox credentials and `PAYPAL_ENVIRONMENT=sandbox` until the complete purchase, return, token issuance, refresh, recovery, refund, and revocation flow passes. Switch to live credentials and `PAYPAL_ENVIRONMENT=live` only after sandbox verification.

## Independent D1 backups

Provision the private R2 bucket and GitHub Actions secrets documented in [Supporter D1 Backup and Recovery](SUPPORTER_BACKUP_RECOVERY.md), then manually run `Supporter D1 Backup` once before enabling payments. The backup workflow is intentionally separate from Worker deployment: missing R2 configuration cannot prevent the supporter service from deploying, and a Worker defect cannot silently disable the independent export job.

## Desktop release configuration

Set these non-secret GitHub repository variables before tagging a release:

- `SUPPORTER_SERVICE_URL`
- `SUPPORTER_PUBLIC_KEY` — the unpadded base64url Ed25519 public key (`x` from the signing JWK)

The release workflow passes them to Rust as `TELEGRAM_DRIVE_SUPPORTER_SERVICE_URL` and `TELEGRAM_DRIVE_SUPPORTER_PUBLIC_KEY`. These stable values ensure normal app updates reuse existing activations. Rotating the signing key requires a planned multi-key verification rollout; replacing it without that rollout invalidates locally cached tokens.

## Operational checks

Before publishing a desktop release:

1. Confirm `/health` returns the expected terms version, price, device limit, and public key.
2. Complete an ASCII and Unicode PayPal sandbox payer checkout.
3. Confirm the desktop app displays and securely saves the recovery code.
4. Restart and update the app; verify it remains ad-free without reactivation.
5. Restore on a second test device with the recovery code, then confirm the fourth activation is rejected.
6. Refund the sandbox capture and confirm the next online refresh revokes ad-free access.
7. Confirm no email, Telegram identifier, file metadata, or IP address is persisted in D1.
8. Confirm the latest scheduled D1 archive and checksum exist in R2, and keep a dated record of the most recent successful restore drill.
