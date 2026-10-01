# Supporter service E2E checks

Run `npm run test:e2e` (also the implementation of `npm test`) with Node 22 or newer. The runner starts the actual Worker in workerd, applies the checked-in SQL migrations to an isolated local D1 database, and sends real HTTP requests over loopback. Production handlers, database operations, signature verification and encryption are not mocked. No Vitest or isolated function tests remain.

The sole substituted service is the external PayPal sandbox HTTP boundary. It simulates order creation, canonical order reads, capture responses and webhook verification so these checks never create a real charge or contact production. Any unexpected outbound host or endpoint fails the scenario. Test signing keys are generated for each run and are never written into the repository. No backup/R2 binding is provided.

Scenarios exercise the one-time $5 USD contract, accepted terms, exact merchant/claim/payment evidence, return and webhook completion, retry and deduplication, encrypted recovery receipts, explicit acknowledgement, Worker restart and scheduled maintenance, three-device admission races, historical over-limit activation compatibility, signed refresh and replay rejection, expired-token recovery, refunds/reversals/disputes, and D1/log privacy. The client independently verifies emitted Ed25519 tokens with Node's crypto API, including the 30-day verification and seven-day offline-grace fields.

D1 access outside HTTP is limited to migration setup, test isolation, inspection of persisted outcomes, and modeling historical records or elapsed time. Purchase and activation fixtures are created through the public API. Scheduled maintenance enters the runtime's local scheduled-event endpoint. The suite does not import production functions.

These are service E2E scenarios. They do not replace a real PayPal sandbox certification exercise, a Cloudflare deployment check, or packaged desktop/Android UI, secure-storage and offline-ad-suppression checks. Those checks belong at their respective system boundaries. This suite makes no claim of complete branch coverage or zero remaining bugs.

The package override keeps Miniflare's image dependency on patched `sharp` 0.35.4 for [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). Miniflare and Wrangler otherwise keep their existing versions. Remove the override when their own dependency declarations use a patched version; do not replace it with an advisory exception.
