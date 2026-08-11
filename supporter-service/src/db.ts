import type { CheckoutClaimRow, DeviceRow, EntitlementRow, Env } from './types';

export async function insertCheckoutClaim(
  env: Env,
  claim: Pick<CheckoutClaimRow, 'id' | 'claim_secret_hash' | 'device_public_key' | 'device_key_hash' | 'terms_version' | 'terms_accepted_at' | 'created_at' | 'expires_at'>,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO checkout_claims (
      id, claim_secret_hash, device_public_key, device_key_hash, status,
      terms_version, terms_accepted_at, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?)
  `).bind(
    claim.id,
    claim.claim_secret_hash,
    claim.device_public_key,
    claim.device_key_hash,
    claim.terms_version,
    claim.terms_accepted_at,
    claim.created_at,
    claim.expires_at,
  ).run();
}

export async function markCheckoutPending(env: Env, claimId: string, orderId: string, approvalUrl: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE checkout_claims
    SET paypal_order_id = ?, approval_url = ?, status = 'pending', error_code = NULL
    WHERE id = ? AND status = 'creating'
  `).bind(orderId, approvalUrl, claimId).run();
}

export async function markCheckoutFailed(env: Env, claimId: string, errorCode: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE checkout_claims SET status = 'failed', error_code = ?
    WHERE id = ? AND status IN ('creating', 'pending')
  `).bind(errorCode, claimId).run();
}

export async function markCheckoutCancelled(env: Env, claimId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE checkout_claims SET status = 'cancelled', error_code = NULL
    WHERE id = ? AND status IN ('creating', 'pending')
  `).bind(claimId).run();
}

export async function beginCheckoutCompletion(env: Env, claimId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE checkout_claims SET status = 'processing', processing_started_at = ?
    WHERE id = ? AND (
      status IN ('creating', 'pending')
      OR (status = 'processing' AND processing_started_at < ?)
    )
  `).bind(now, claimId, now - 60).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseCheckoutCompletion(env: Env, claimId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE checkout_claims SET status = 'pending', processing_started_at = NULL
    WHERE id = ? AND status = 'processing'
  `).bind(claimId).run();
}

export async function markRecoveryDelivered(env: Env, claimId: string, deliveredAt: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE checkout_claims SET recovery_delivered_at = ?
    WHERE id = ? AND status = 'completed' AND recovery_delivered_at IS NULL
  `).bind(deliveredAt, claimId).run();
}

export async function getCheckoutClaim(env: Env, claimId: string): Promise<CheckoutClaimRow | null> {
  return env.DB.prepare('SELECT * FROM checkout_claims WHERE id = ?').bind(claimId).first<CheckoutClaimRow>();
}

export async function getCheckoutByOrder(env: Env, orderId: string): Promise<CheckoutClaimRow | null> {
  return env.DB.prepare('SELECT * FROM checkout_claims WHERE paypal_order_id = ?').bind(orderId).first<CheckoutClaimRow>();
}

export async function findPendingCheckoutForDevice(env: Env, deviceKeyHash: string, now: number): Promise<CheckoutClaimRow | null> {
  return env.DB.prepare(`
    SELECT * FROM checkout_claims
    WHERE device_key_hash = ? AND status = 'pending' AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(deviceKeyHash, now).first<CheckoutClaimRow>();
}

export async function completeCheckout(
  env: Env,
  details: {
    claim: CheckoutClaimRow;
    entitlementId: string;
    captureId: string;
    amount: string;
    currency: string;
    recoveryLookupHash: string;
    recoveryCiphertext: string;
    recoveryNonce: string;
    completedAt: number;
  },
): Promise<void> {
  const existing = await getCheckoutClaim(env, details.claim.id);
  if (existing?.status === 'completed') return;
  if (!details.claim.paypal_order_id) throw new Error('Checkout order is missing');

  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO entitlements (
        id, paypal_order_id, paypal_capture_id, status, amount, currency,
        recovery_lookup_hash, terms_version, created_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).bind(
      details.entitlementId,
      details.claim.paypal_order_id,
      details.captureId,
      details.amount,
      details.currency,
      details.recoveryLookupHash,
      details.claim.terms_version,
      details.completedAt,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO entitlement_devices (
        entitlement_id, device_key_hash, device_public_key, activated_at, last_refreshed_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      details.entitlementId,
      details.claim.device_key_hash,
      details.claim.device_public_key,
      details.completedAt,
      details.completedAt,
    ),
    env.DB.prepare(`
      UPDATE checkout_claims
      SET status = 'completed', completed_at = ?, entitlement_id = ?,
          recovery_ciphertext = ?, recovery_nonce = ?, error_code = NULL
      WHERE id = ? AND status = 'processing'
    `).bind(
      details.completedAt,
      details.entitlementId,
      details.recoveryCiphertext,
      details.recoveryNonce,
      details.claim.id,
    ),
  ]);
}

export async function getEntitlement(env: Env, entitlementId: string): Promise<EntitlementRow | null> {
  return env.DB.prepare('SELECT * FROM entitlements WHERE id = ?').bind(entitlementId).first<EntitlementRow>();
}

export async function getEntitlementByCapture(env: Env, captureId: string): Promise<EntitlementRow | null> {
  return env.DB.prepare('SELECT * FROM entitlements WHERE paypal_capture_id = ?').bind(captureId).first<EntitlementRow>();
}

export async function getEntitlementByOrder(env: Env, orderId: string): Promise<EntitlementRow | null> {
  return env.DB.prepare('SELECT * FROM entitlements WHERE paypal_order_id = ?').bind(orderId).first<EntitlementRow>();
}

export async function findEntitlementByRecoveryHash(env: Env, recoveryHash: string): Promise<EntitlementRow | null> {
  return env.DB.prepare('SELECT * FROM entitlements WHERE recovery_lookup_hash = ?').bind(recoveryHash).first<EntitlementRow>();
}

export async function getDevice(env: Env, entitlementId: string, deviceKeyHash: string): Promise<DeviceRow | null> {
  return env.DB.prepare(`
    SELECT * FROM entitlement_devices WHERE entitlement_id = ? AND device_key_hash = ?
  `).bind(entitlementId, deviceKeyHash).first<DeviceRow>();
}

export async function countActiveDevices(env: Env, entitlementId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM entitlement_devices
    WHERE entitlement_id = ? AND revoked_at IS NULL
  `).bind(entitlementId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function activateDevice(env: Env, entitlementId: string, deviceKeyHash: string, devicePublicKey: string, now: number): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO entitlement_devices (
      entitlement_id, device_key_hash, device_public_key, activated_at, last_refreshed_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(entitlement_id, device_key_hash) DO UPDATE SET
      device_public_key = excluded.device_public_key,
      last_refreshed_at = excluded.last_refreshed_at,
      revoked_at = NULL
  `).bind(entitlementId, deviceKeyHash, devicePublicKey, now, now).run();
}

export async function touchDevice(env: Env, entitlementId: string, deviceKeyHash: string, now: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE entitlement_devices SET last_refreshed_at = ?
    WHERE entitlement_id = ? AND device_key_hash = ? AND revoked_at IS NULL
  `).bind(now, entitlementId, deviceKeyHash).run();
}

export async function createChallenge(
  env: Env,
  challengeId: string,
  entitlementId: string,
  deviceKeyHash: string,
  nonceHash: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO activation_challenges (
      id, entitlement_id, device_key_hash, nonce_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(challengeId, entitlementId, deviceKeyHash, nonceHash, now, now + 300).run();
}

export async function consumeChallenge(
  env: Env,
  challengeId: string,
  entitlementId: string,
  deviceKeyHash: string,
  nonceHash: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE activation_challenges SET consumed_at = ?
    WHERE id = ? AND entitlement_id = ? AND device_key_hash = ? AND nonce_hash = ?
      AND consumed_at IS NULL AND expires_at >= ?
  `).bind(now, challengeId, entitlementId, deviceKeyHash, nonceHash, now).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function recordWebhook(env: Env, eventId: string, eventType: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO webhook_events (id, event_type, received_at)
    VALUES (?, ?, ?)
  `).bind(eventId, eventType, now).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function finishWebhook(env: Env, eventId: string, result: string, now: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE webhook_events SET processed_at = ?, result = ? WHERE id = ?
  `).bind(now, result, eventId).run();
}

export async function discardWebhook(env: Env, eventId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM webhook_events WHERE id = ? AND processed_at IS NULL').bind(eventId).run();
}

export async function revokeEntitlementByCapture(env: Env, captureId: string, reason: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE entitlements SET status = 'revoked', revoked_at = ?, revocation_reason = ?
    WHERE paypal_capture_id = ? AND status = 'active'
  `).bind(now, reason, captureId).run();
  return (result.meta.changes ?? 0) === 1;
}


export async function revokeEntitlementByOrder(env: Env, orderId: string, reason: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE entitlements SET status = 'revoked', revoked_at = ?, revocation_reason = ?
    WHERE paypal_order_id = ? AND status = 'active'
  `).bind(now, reason, orderId).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function cleanupExpiredRecords(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE checkout_claims SET status = 'expired', approval_url = NULL
      WHERE status IN ('creating', 'pending') AND expires_at < ?
    `).bind(now),
    env.DB.prepare(`
      UPDATE checkout_claims SET recovery_ciphertext = NULL, recovery_nonce = NULL
      WHERE status = 'completed' AND recovery_delivered_at IS NOT NULL AND recovery_delivered_at < ?
    `).bind(now - 86_400),
    env.DB.prepare(`
      UPDATE checkout_claims SET status = 'pending', processing_started_at = NULL
      WHERE status = 'processing' AND processing_started_at < ?
    `).bind(now - 300),
    env.DB.prepare('DELETE FROM activation_challenges WHERE expires_at < ?').bind(now - 86_400),
  ]);
}
