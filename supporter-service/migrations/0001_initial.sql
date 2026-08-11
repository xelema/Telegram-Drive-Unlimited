PRAGMA foreign_keys = ON;

CREATE TABLE checkout_claims (
    id TEXT PRIMARY KEY,
    claim_secret_hash TEXT NOT NULL UNIQUE,
    paypal_order_id TEXT UNIQUE,
    approval_url TEXT,
    device_public_key TEXT NOT NULL,
    device_key_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'processing', 'completed', 'cancelled', 'expired', 'failed')),
    terms_version TEXT NOT NULL,
    terms_accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_at INTEGER,
    processing_started_at INTEGER,
    entitlement_id TEXT,
    recovery_ciphertext TEXT,
    recovery_nonce TEXT,
    recovery_delivered_at INTEGER,
    error_code TEXT
);

CREATE INDEX checkout_claims_device_status_idx
    ON checkout_claims(device_key_hash, status, expires_at);

CREATE TABLE entitlements (
    id TEXT PRIMARY KEY,
    paypal_order_id TEXT NOT NULL UNIQUE,
    paypal_capture_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    recovery_lookup_hash TEXT NOT NULL UNIQUE,
    terms_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT
);

CREATE TABLE entitlement_devices (
    entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
    device_key_hash TEXT NOT NULL,
    device_public_key TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    last_refreshed_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (entitlement_id, device_key_hash)
);

CREATE INDEX entitlement_devices_active_idx
    ON entitlement_devices(entitlement_id, revoked_at);

CREATE TABLE activation_challenges (
    id TEXT PRIMARY KEY,
    entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
    device_key_hash TEXT NOT NULL,
    nonce_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
);

CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    result TEXT
);

CREATE INDEX webhook_events_received_idx ON webhook_events(received_at);
