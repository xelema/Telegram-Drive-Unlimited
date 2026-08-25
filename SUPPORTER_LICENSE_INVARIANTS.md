# $5 Lifetime Supporter License Compatibility Contract

This document records the user-facing and technical contract that future maintenance must preserve. It applies to the desktop application, supporter Worker, release workflows, advertisement visibility, secure local state, and database migrations.

## User promise

- The supporter purchase is optional and costs exactly **$5.00 USD once**.
- A verified purchase grants the **lifetime ad-free supporter entitlement**. It is not a subscription and has no recurring charge.
- Existing purchasers are never asked to repurchase because of an application update, token refresh, temporary service outage, internal refactor, or backup failure.
- Every application feature remains available without payment. The supporter entitlement removes sponsor advertisements; it does not unlock a paid feature tier.
- The entitlement supports up to three active supported devices. A purchaser can restore access with the recovery code, subject to that allowance.
- Refunds, reversals, chargebacks, and purchaser-favour disputes may revoke the matching entitlement as stated in the accepted supporter terms.

## Compatibility invariants

1. A successfully verified PayPal capture must match the configured merchant, checkout claim, `5.00` amount, and `USD` currency before an entitlement is issued.
2. Entitlements remain cryptographically signed and bound to the device key. The private signing key stays in Worker secrets; released applications contain only the matching public key and HTTPS service origin.
3. `active` and `needs_refresh`/offline-grace states keep `ad_free: true`. Sponsor content must remain hidden while entitlement state is loading so startup cannot flash an advertisement at a licensed user.
4. Normal updates reuse the stable secure credential service `com.cameronamer.telegramdrive.supporter`, stable credential account identifiers, local entitlement state, and compatible signed-token format.
5. Existing entitlements and recovery codes remain usable across releases. Changes to signing keys, token claims, storage identifiers, terms handling, D1 schema, or device-key derivation require an explicit backward-compatible migration.
6. An expired verification token is a refresh/recovery condition, not a reason to offer an existing purchaser another checkout. A saved recovery code or known prior entitlement must suppress repurchase prompts.
7. The D1/R2 backup system is independent disaster-recovery infrastructure. Backup success or failure must never gate checkout, token issuance, refresh, recovery, local ad suppression, Worker deployment, or application startup.
8. Do not log payment credentials, recovery codes, checkout secrets, private device keys, entitlement signing material, or raw entitlement tokens.

## Required verification for changes

At minimum, run these checks whenever a change can affect this contract:

```bash
cd supporter-service
npm run check
npm test
npx wrangler deploy --dry-run

cd ../app
npm test -- --run tests/unit/SupporterContext.test.tsx tests/unit/SupporterSettingsSection.test.tsx tests/unit/supporterVisibility.test.ts tests/unit/sponsorLinks.test.ts

cd src-tauri
cargo test supporter --lib
```

Before a desktop release, also verify:

- the configured production `/health` endpoint reports `status: ok`, price `5.00`, currency `USD`, and the expected device allowance;
- its entitlement public key exactly matches `SUPPORTER_PUBLIC_KEY` used by the release build;
- the release workflow rejects a missing/invalid HTTPS service URL or public key;
- a sandbox purchase, recovery, update persistence, refresh, device-limit, refund, and revocation exercise passes before any payment-path or schema change reaches production.

Changes to the user promise or compatibility invariants require explicit repository-owner approval. Document the migration and rollback plan before implementation, and preserve already purchased lifetime entitlements.
