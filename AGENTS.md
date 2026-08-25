# Repository Agent Instructions

## $5 lifetime supporter license is a protected compatibility contract

Before changing payments, supporter entitlements, advertisements, release configuration, secure credential storage, or the supporter Cloudflare Worker, read [SUPPORTER_LICENSE_INVARIANTS.md](SUPPORTER_LICENSE_INVARIANTS.md) and [SUPPORTER_SERVICE.md](SUPPORTER_SERVICE.md).

Do not weaken or silently change the established supporter promise:

- one verified payment of exactly $5.00 USD grants the lifetime ad-free supporter entitlement;
- it is not a subscription, and existing purchasers must never be prompted or required to pay again;
- active and offline-grace entitlements must suppress all sponsor advertisements;
- normal application updates must preserve activation;
- recovery-code restoration and the supported device allowance must remain available;
- every application feature remains available to non-paying users;
- backup health must never be used as an entitlement, checkout, refresh, or ad-removal dependency.

Pricing, entitlement rights, device limits, signing-key strategy, stable credential identifiers, token compatibility, revocation policy, or recovery behavior may change only with the repository owner's explicit approval and a reviewed migration plan for existing purchasers. Never rotate the supporter signing key or stable secure-storage identifiers as an incidental refactor.

Any in-scope change must preserve the automated checks listed in `SUPPORTER_LICENSE_INVARIANTS.md`. A live PayPal transaction, production deployment, signing-key rotation, entitlement revocation, or production D1 mutation requires explicit authorization; do not infer it from a general implementation request.
