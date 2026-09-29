import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { day, device, hash, startService, terms } from './local-service.mjs';

let service;
before(async () => { service = await startService(); }, { timeout: 60_000 });
after(async () => { await service?.close(); });
beforeEach(async () => { await service.reset(); });

async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  return response.json();
}
async function error(response, status, code) { assert.equal((await json(response, status)).error.code, code); }
async function checkout(owner = device()) {
  const claim = await json(await service.request('/v1/checkout', { method: 'POST', body: {
    device_public_key: owner.encoded, terms_version: terms, terms_accepted: true, app_version: 'e2e', platform: 'desktop',
  }, headers: { 'cf-connecting-ip': '192.0.2.123' } }), 201);
  const orderId = new URL(claim.approval_url).searchParams.get('token');
  return { ...claim, orderId, owner };
}
const poll = (claim, bearer = claim.claim_secret) => service.request(`/v1/checkout/${claim.claim_id}/status`, { bearer });
const acknowledge = (claim, bearer = claim.claim_secret) => service.request(`/v1/checkout/${claim.claim_id}/acknowledge`, { method: 'POST', bearer });
async function purchase() {
  const claim = await checkout();
  service.paypal.complete(claim.orderId);
  const receipt = await json(await poll(claim));
  assert.equal(receipt.status, 'completed');
  assert.match(receipt.recovery_code, /^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);
  return { ...claim, ...receipt, claims: service.verifyToken(receipt.entitlement_token, claim.owner) };
}
const activate = (receipt, owner, extra = {}) => service.request('/v1/activate', { method: 'POST', body: {
  recovery_code: receipt.recovery_code, device_public_key: owner.encoded, terms_version: terms, terms_accepted: true, ...extra,
} });
async function refreshBody(receipt, token = receipt.entitlement_token, signer = receipt.owner) {
  const challenge = await json(await service.request('/v1/challenge', { method: 'POST', bearer: token }));
  const message = `telegram-drive-supporter-refresh:${challenge.challenge_id}:${challenge.nonce}`;
  return { entitlement_token: token, challenge_id: challenge.challenge_id, nonce: challenge.nonce, signature: sign(null, Buffer.from(message), signer.privateKey).toString('base64url') };
}
const refresh = body => service.request('/v1/refresh', { method: 'POST', body });
const webhookHeaders = () => ({
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/E2ECERT',
  'paypal-transmission-id': `e2e-${randomUUID()}`, 'paypal-transmission-sig': 'ZmFrZS1wYXlwYWwtc2lnbmF0dXJl', 'paypal-transmission-time': new Date().toISOString(),
});
function webhook(event, headers = webhookHeaders(), raw) {
  return service.request('/v1/paypal/webhook', { method: 'POST', body: raw === undefined ? event : undefined, raw, headers });
}
const row = async claim => (await service.sql('SELECT * FROM checkout_claims WHERE id = ?', [claim.claim_id]))[0];
const captures = () => service.paypal.calls.filter(call => call.path.endsWith('/capture'));
const creations = () => service.paypal.calls.filter(call => call.method === 'POST' && call.path === '/v2/checkout/orders');

test('health and terms publish the protected lifetime contract without any backup dependency', async () => {
  assert.deepEqual(await json(await service.request('/health')), {
    status: 'ok', terms_version: terms, price: '5.00', currency: 'USD', max_active_devices: 3,
    entitlement_public_key: JSON.parse(service.env.ENTITLEMENT_SIGNING_JWK).x,
  });
  const response = await service.request('/terms');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  for (const statement of ['one-time payment of 5.00 USD', 'up to 3', 'every application feature remains available', 'recovery code', 'revokes', 'does not request or store your PayPal email address']) assert.ok(html.includes(statement));
  assert.equal(service.paypal.calls.length, 0);
});

test('HTTP validation rejects invalid JSON, content types, terms and device keys before creating a payment', async () => {
  await error(await service.request('/v1/checkout', { method: 'POST', raw: '{' }), 400, 'INVALID_JSON');
  await error(await service.request('/v1/checkout', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'CONTENT_TYPE_REQUIRED');
  await error(await service.request('/v1/checkout', { method: 'POST', body: { device_public_key: 'invalid' } }), 400, 'INVALID_DEVICE_KEY');
  for (const acceptance of [{ terms_accepted: false, terms_version: terms }, { terms_accepted: true, terms_version: 'old-terms' }]) {
    await error(await service.request('/v1/checkout', { method: 'POST', body: { device_public_key: device().encoded, ...acceptance } }), 400, 'TERMS_NOT_ACCEPTED');
  }
  assert.equal(service.paypal.calls.length, 0);
  assert.equal((await service.sql('SELECT * FROM checkout_claims')).length, 0);
});

test('a complete HTTP checkout captures once, reads canonical evidence and independently verifies its device-bound signature', async () => {
  const claim = await checkout();
  assert.equal(creations()[0].requestId, `telegram-drive-${claim.claim_id}`);
  const pending = await json(await poll(claim));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.approval_url, claim.approval_url);
  const response = await service.request(`/checkout/return?claim=${claim.claim_id}&token=${claim.orderId}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Supporter activation confirmed/);
  const receipt = await json(await poll(claim));
  const claims = service.verifyToken(receipt.entitlement_token, claim.owner);
  assert.equal(captures().length, 1);
  assert.equal(creations().length, 1);
  assert.equal((await service.sql('SELECT * FROM entitlements'))[0].id, claims.entitlement_id);
  const persisted = await row(claim);
  assert.equal(persisted.terms_version, terms);
  assert.ok(persisted.terms_accepted_at > 0);
  assert.notEqual(persisted.claim_secret_hash, claim.claim_secret);
  assert.notEqual(persisted.recovery_ciphertext, receipt.recovery_code);
  await service.request(`/checkout/return?claim=${claim.claim_id}&token=${claim.orderId}`);
  assert.equal(captures().length, 1, 'Returning or polling must not charge an existing purchaser again');
});

test('payment-provider outages retain the original unresolved checkout and recover without a second payment', async () => {
  const claim = await checkout();
  service.paypal.unavailable = true;
  const pending = await json(await poll(claim));
  assert.equal(pending.unpaid_final, false);
  assert.equal(pending.error_code, 'PAYMENT_VERIFICATION_PENDING');
  assert.equal((await row(claim)).status, 'pending');
  service.paypal.unavailable = false;
  service.paypal.complete(claim.orderId);
  assert.equal((await json(await poll(claim))).status, 'completed');
  assert.equal(creations().length, 1);
  assert.equal(captures().length, 0);
});

test('checkout creation reports an unavailable provider without inventing a purchase or recovery entitlement', async () => {
  service.paypal.unavailable = true;
  await error(await service.request('/v1/checkout', { method: 'POST', body: {
    device_public_key: device().encoded, terms_version: terms, terms_accepted: true,
  } }), 503, 'PAYMENT_SERVICE_UNAVAILABLE');
  assert.equal((await service.sql('SELECT * FROM entitlements')).length, 0);
  assert.equal((await service.sql('SELECT * FROM checkout_claims'))[0].status, 'failed');
  assert.equal(captures().length, 0);
});

for (const mismatch of ['order', 'claim', 'merchant', 'amount', 'currency', 'capture_status', 'missing_capture']) {
  test(`completed payment with mismatched ${mismatch} cannot issue an entitlement`, async () => {
    const claim = await checkout();
    const order = service.paypal.complete(claim.orderId);
    const unit = order.purchase_units[0];
    if (mismatch === 'order') order.id = 'OTHERORDER';
    if (mismatch === 'claim') unit.custom_id = randomUUID();
    if (mismatch === 'merchant') { unit.payee.merchant_id = 'attacker'; unit.payments.captures[0].payee.merchant_id = 'attacker'; }
    if (mismatch === 'amount') unit.payments.captures[0].amount.value = '4.99';
    if (mismatch === 'currency') unit.payments.captures[0].amount.currency_code = 'EUR';
    if (mismatch === 'capture_status') unit.payments.captures[0].status = 'PENDING';
    if (mismatch === 'missing_capture') unit.payments.captures = [];
    const body = await json(await poll(claim));
    assert.equal(body.status, 'pending');
    assert.equal(body.unpaid_final, false);
    assert.equal(body.entitlement_token, undefined);
    assert.equal((await service.sql('SELECT * FROM entitlements')).length, 0);
    assert.equal(creations().length, 1);
    assert.equal(captures().length, 0);
  });
}

test('a lost purchase response survives a Worker restart and scheduled cleanup until authenticated acknowledgement', async () => {
  const receipt = await purchase();
  const old = Math.floor(Date.now() / 1000) - 3 * day;
  // Simulate the passage of days in durable storage, never bypass completion.
  await service.sql('UPDATE checkout_claims SET created_at = ?, completed_at = ?, expires_at = ?, recovery_delivered_at = ? WHERE id = ?', [old, old, old + 1800, old, receipt.claim_id]);
  await service.restart();
  const scheduled = await service.request('/cdn-cgi/local/scheduled?cron=17%203%20*%20*%20*');
  assert.equal(scheduled.status, 200, await scheduled.text());
  const replay = await json(await poll(receipt));
  assert.equal(replay.recovery_code, receipt.recovery_code);
  assert.equal(service.verifyToken(replay.entitlement_token, receipt.owner).entitlement_id, receipt.claims.entitlement_id);
  const before = await row(receipt);
  await error(await acknowledge(receipt, 'wrong-secret'), 404, 'CLAIM_NOT_FOUND');
  await error(await acknowledge(receipt, ''), 404, 'CLAIM_NOT_FOUND');
  await error(await poll(receipt, ''), 404, 'CLAIM_NOT_FOUND');
  assert.deepEqual(await row(receipt), before);
  assert.deepEqual(await json(await acknowledge(receipt)), { status: 'acknowledged' });
  const acknowledged = await row(receipt);
  assert.equal(acknowledged.recovery_ciphertext, null);
  assert.equal(acknowledged.recovery_nonce, null);
  await json(await acknowledge(receipt));
  assert.deepEqual(await row(receipt), acknowledged);
  assert.equal((await json(await poll(receipt))).recovery_code, undefined);
  await json(await activate(receipt, device()));
  assert.equal(creations().length, 1);
});

test('unresolved checkouts reject acknowledgement and recover paid orders after cancellation or expiration', async () => {
  for (const state of ['cancelled', 'expired']) {
    const claim = await checkout();
    await error(await acknowledge(claim), 409, 'CHECKOUT_UNRESOLVED');
    if (state === 'cancelled') await service.request(`/checkout/cancel?claim=${claim.claim_id}`);
    else {
      await service.sql('UPDATE checkout_claims SET expires_at = ? WHERE id = ?', [1, claim.claim_id]);
      assert.equal((await service.request('/cdn-cgi/local/scheduled')).status, 200);
    }
    assert.equal((await row(claim)).status, state);
    service.paypal.complete(claim.orderId);
    assert.equal((await json(await poll(claim))).status, 'completed');
  }
  assert.equal(captures().length, 0);
  assert.equal(creations().length, 2);
});

test('only exact unpaid evidence releases a checkout; unsafe histories and approval links stay unresolved', async () => {
  const claim = await checkout();
  const original = structuredClone(service.paypal.orders.get(claim.orderId));
  for (const state of ['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED', 'VOIDED']) {
    for (const mismatch of ['merchant', 'claim', 'order', 'amount', 'currency', 'captures', 'pending_capture', 'refunds', 'authorizations', 'malformed', 'multiple_units']) {
      const order = structuredClone(original);
      order.status = state;
      const unit = order.purchase_units[0];
      if (mismatch === 'merchant') unit.payee.merchant_id = 'wrong';
      if (mismatch === 'claim') unit.custom_id = randomUUID();
      if (mismatch === 'order') order.id = 'OTHERORDER';
      if (mismatch === 'amount') unit.amount.value = '10.00';
      if (mismatch === 'currency') unit.amount.currency_code = 'EUR';
      if (['captures', 'refunds', 'authorizations'].includes(mismatch)) unit.payments = { [mismatch]: [{ id: 'EXISTINGPAYMENT' }] };
      if (mismatch === 'pending_capture') unit.payments = { captures: [{ id: 'EXISTINGPAYMENT', status: 'PENDING' }] };
      if (mismatch === 'malformed') unit.payments = { captures: null };
      if (mismatch === 'multiple_units') order.purchase_units.push({ ...unit });
      service.paypal.orders.set(claim.orderId, order);
      const body = await json(await poll(claim));
      assert.equal(body.status, 'pending', `${state}/${mismatch}`);
      assert.equal(body.unpaid_final, false);
      assert.equal(body.approval_url, undefined);
    }
    service.paypal.orders.set(claim.orderId, { ...structuredClone(original), status: state });
    const body = await json(await poll(claim));
    if (state === 'VOIDED') assert.equal(body.unpaid_final, true);
    else assert.equal(body.approval_url, claim.approval_url);
  }
  for (const href of ['https://paypal.com.attacker.invalid/checkout', 'http://paypal.com/checkout', 'https://user:password@paypal.com/checkout']) {
    service.paypal.orders.set(claim.orderId, { ...structuredClone(original), links: [{ rel: 'approve', href }] });
    assert.equal((await json(await poll(claim))).approval_url, undefined);
  }
  assert.equal(captures().length, 0);
  assert.equal(creations().length, 1);
  assert.equal((await service.sql('SELECT * FROM entitlements')).length, 0);
});

test('recovery accepts three devices, limits concurrent fourth devices and preserves existing activations', async () => {
  const receipt = await purchase();
  const second = device();
  const third = device();
  const fourth = device();
  await json(await activate(receipt, second, { recovery_code: receipt.recovery_code.toLowerCase().replaceAll('-', ' ') }));
  const admissions = await Promise.all([activate(receipt, third), activate(receipt, fourth)]);
  assert.deepEqual(admissions.map(response => response.status).sort(), [200, 409]);
  const winner = admissions[0].status === 200 ? third : fourth;
  for (const response of admissions) {
    if (response.status === 200) service.verifyToken((await json(response)).entitlement_token, winner);
    else await error(response, 409, 'DEVICE_LIMIT_REACHED');
  }
  for (const response of await Promise.all(Array.from({ length: 4 }, () => activate(receipt, winner)))) {
    service.verifyToken((await json(response)).entitlement_token, winner);
  }
  await error(await activate(receipt, device()), 409, 'DEVICE_LIMIT_REACHED');
  assert.equal((await service.sql('SELECT * FROM entitlement_devices WHERE revoked_at IS NULL')).length, 3);
  service.verifyToken((await json(await refresh(await refreshBody(receipt)))).entitlement_token, receipt.owner);
  assert.equal(creations().length, 1);
});

test('inactive-device recovery competes atomically for one remaining slot without modifying denied devices', async () => {
  const receipt = await purchase();
  const inactive = device();
  await json(await activate(receipt, inactive));
  // Imported legacy state is setup only. All admission goes through /activate.
  await service.sql('UPDATE entitlement_devices SET revoked_at = 1 WHERE device_key_hash = ?', [hash(inactive.encoded)]);
  await json(await activate(receipt, device()));
  const newcomer = device();
  const responses = await Promise.all([activate(receipt, inactive), activate(receipt, newcomer)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const rows = await service.sql('SELECT * FROM entitlement_devices WHERE revoked_at IS NULL');
  assert.equal(rows.length, 3);
  if (responses[0].status === 409) assert.equal((await service.sql('SELECT revoked_at FROM entitlement_devices WHERE device_key_hash = ?', [hash(inactive.encoded)]))[0].revoked_at, 1);
  if (responses[1].status === 409) assert.equal((await service.sql('SELECT * FROM entitlement_devices WHERE device_key_hash = ?', [hash(newcomer.encoded)])).length, 0);
  await json(await refresh(await refreshBody(receipt)));
});

test('legacy purchases already above the device allowance retain every existing activation after restart', async () => {
  const receipt = await purchase();
  const owners = [receipt.owner, device(), device(), device()];
  await json(await activate(receipt, owners[1]));
  await json(await activate(receipt, owners[2]));
  // Model a purchase admitted by an older release, not a new activation path.
  await service.sql('INSERT INTO entitlement_devices (entitlement_id, device_key_hash, device_public_key, activated_at, last_refreshed_at) VALUES (?, ?, ?, 1, 1)',
    [receipt.claims.entitlement_id, hash(owners[3].encoded), owners[3].encoded]);
  await service.restart();
  for (const owner of owners) {
    const restored = await json(await activate(receipt, owner));
    service.verifyToken(restored.entitlement_token, owner);
    await json(await refresh(await refreshBody({ owner, entitlement_token: restored.entitlement_token })));
  }
  await error(await activate(receipt, device()), 409, 'DEVICE_LIMIT_REACHED');
  const separate = await purchase();
  await json(await activate(separate, device()));
  assert.equal((await service.sql('SELECT * FROM entitlement_devices WHERE entitlement_id = ? AND revoked_at IS NULL', [receipt.claims.entitlement_id])).length, 4);
  assert.equal(creations().length, 2);
});

test('signed refresh rejects the wrong key, bad nonce and replay without losing a valid lifetime activation', async () => {
  const receipt = await purchase();
  const invalidProof = await refreshBody(receipt, receipt.entitlement_token, device());
  await error(await refresh(invalidProof), 403, 'DEVICE_PROOF_INVALID');
  const body = await refreshBody(receipt);
  const wrongNonce = { ...body, nonce: 'wrong-nonce' };
  wrongNonce.signature = sign(null, Buffer.from(`telegram-drive-supporter-refresh:${body.challenge_id}:${wrongNonce.nonce}`), receipt.owner.privateKey).toString('base64url');
  await error(await refresh(wrongNonce), 409, 'CHALLENGE_INVALID');
  assert.equal(service.verifyToken((await json(await refresh(body))).entitlement_token, receipt.owner).entitlement_id, receipt.claims.entitlement_id);
  await error(await refresh(body), 409, 'CHALLENGE_INVALID');
  const expired = await refreshBody(receipt);
  await service.sql('UPDATE activation_challenges SET expires_at = 1 WHERE id = ?', [expired.challenge_id]);
  await error(await refresh(expired), 409, 'CHALLENGE_INVALID');
  await json(await refresh(await refreshBody(receipt)));
});

test('compatible expired tokens refresh after restart without payment, while forged or incompatible tokens are rejected', async () => {
  const receipt = await purchase();
  const expired = { ...receipt.claims, issued_at: 1, expires_at: 30 * day + 1, offline_until: 37 * day + 1 };
  const oldToken = service.historicalToken(expired);
  await service.restart();
  const refreshed = await json(await refresh(await refreshBody(receipt, oldToken)));
  assert.equal(service.verifyToken(refreshed.entitlement_token, receipt.owner).entitlement_id, receipt.claims.entitlement_id);
  const broken = [
    `${receipt.entitlement_token.split('.').slice(0, 2).join('.')}.${Buffer.alloc(64).toString('base64url')}`,
    service.historicalToken(receipt.claims, { alg: 'none', typ: 'TD-SUPPORTER', kid: 'v1' }),
    service.historicalToken({ ...receipt.claims, offline_until: receipt.claims.expires_at - 1 }),
    service.historicalToken({ ...receipt.claims, aud: 'unrelated-app' }),
  ];
  for (const token of broken) assert.ok((await service.request('/v1/challenge', { method: 'POST', bearer: token })).status >= 400);
  assert.equal(creations().length, 1);
  assert.equal((await service.sql('SELECT * FROM entitlements'))[0].status, 'active');
});

test('webhook verification preserves Unicode raw bytes, rejects untrusted certificates and retries provider outages', async () => {
  const receipt = await purchase();
  const event = { id: 'WH-UNICODE', event_type: 'IGNORED.EVENT', resource: { name: 'Zoë 測試', amount: 5.00 } };
  const raw = '{ "id": "WH-UNICODE", "event_type": "IGNORED.EVENT", "resource": { "name": "Zoë 測試", "amount": 5.00 } }';
  for (const value of [null, [], 'event', { id: 'NO-TYPE' }]) await error(await webhook(value), 400, 'INVALID_WEBHOOK');
  await error(await webhook(event, {}), 401, 'WEBHOOK_NOT_VERIFIED');
  await error(await webhook(event, { ...webhookHeaders(), 'paypal-cert-url': 'https://attacker.invalid/v1/notifications/certs/X' }), 401, 'WEBHOOK_NOT_VERIFIED');
  assert.equal(service.paypal.verificationBodies.length, 0);
  service.paypal.expectedRawEvent = raw;
  service.paypal.verification = 'FAILURE';
  await error(await webhook(event, webhookHeaders(), raw), 401, 'WEBHOOK_NOT_VERIFIED');
  service.paypal.verification = 'SUCCESS';
  service.paypal.verificationUnavailable = true;
  await error(await webhook(event, webhookHeaders(), raw), 503, 'WEBHOOK_VERIFICATION_UNAVAILABLE');
  assert.equal((await service.sql('SELECT * FROM webhook_events')).length, 0);
  service.paypal.verificationUnavailable = false;
  assert.deepEqual(await json(await webhook(event, webhookHeaders(), raw)), { status: 'ignored' });
  assert.deepEqual(await json(await webhook(event, webhookHeaders(), raw)), { status: 'duplicate' });
  assert.equal((await service.sql('SELECT * FROM entitlements'))[0].status, 'active');
  await json(await refresh(await refreshBody(receipt)));
});

test('failed webhook finalization is retryable and creates one entitlement when the original payment recovers', async () => {
  const claim = await checkout();
  const event = { id: 'WH-APPROVED', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: claim.orderId } };
  const order = service.paypal.complete(claim.orderId);
  order.purchase_units[0].payments.captures[0].amount.value = '4.99';
  await error(await webhook(event), 500, 'WEBHOOK_PROCESSING_FAILED');
  assert.equal((await service.sql('SELECT * FROM webhook_events')).length, 0);
  service.paypal.complete(claim.orderId);
  assert.deepEqual(await json(await webhook(event)), { status: 'activated' });
  assert.deepEqual(await json(await webhook(event)), { status: 'duplicate' });
  assert.equal((await service.sql('SELECT * FROM entitlements')).length, 1);
  assert.equal((await json(await poll(claim))).status, 'completed');
  assert.equal(creations().length, 1);
});

test('a capture-completed webhook verifies the original order through GET and never initiates a second capture', async () => {
  const claim = await checkout();
  service.paypal.complete(claim.orderId);
  const event = { id: 'WH-CAPTURE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
    id: `CAPTURE${claim.orderId}`, supplementary_data: { related_ids: { order_id: claim.orderId } },
  } };
  assert.deepEqual(await json(await webhook(event)), { status: 'activated' });
  assert.deepEqual(await json(await webhook(event)), { status: 'duplicate' });
  service.verifyToken((await json(await poll(claim))).entitlement_token, claim.owner);
  assert.equal(captures().length, 0);
  assert.equal(creations().length, 1);
});

for (const eventType of ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.RESOLVED']) {
  test(`${eventType} revokes only the matching purchase and blocks refresh and recovery`, async () => {
    const receipt = await purchase();
    const other = await purchase();
    const preissuedRefresh = await refreshBody(receipt);
    const captureId = `CAPTURE${receipt.orderId}`;
    const resource = eventType === 'CUSTOMER.DISPUTE.RESOLVED'
      ? { dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' }, disputed_transactions: [{ seller_transaction_id: captureId }] }
      : { id: 'REFUNDEVENT', links: [{ href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: 'up' }] };
    const event = { id: `WH-${eventType}`, event_type: eventType, resource };
    assert.deepEqual(await json(await webhook(event)), { status: 'revoked' });
    assert.deepEqual(await json(await webhook(event)), { status: 'duplicate' });
    await error(await service.request('/v1/challenge', { method: 'POST', bearer: receipt.entitlement_token }), 403, 'ENTITLEMENT_NOT_ACTIVE');
    assert.equal((await refresh(preissuedRefresh)).status, 403);
    await error(await activate(receipt, device()), 404, 'RECOVERY_CODE_INVALID');
    await error(await poll(receipt), 403, 'ENTITLEMENT_NOT_ACTIVE');
    await json(await refresh(await refreshBody(other)));
    assert.equal((await service.sql('SELECT * FROM entitlements WHERE status = ?', ['active'])).length, 1);
  });
}

test('seller-favour disputes preserve activation and private payment/client data never enters D1 or logs', async () => {
  const receipt = await purchase();
  const event = { id: 'WH-SELLER', event_type: 'CUSTOMER.DISPUTE.RESOLVED', resource: {
    dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' }, disputed_transactions: [{ seller_transaction_id: `CAPTURE${receipt.orderId}` }],
    email_address: 'webhook-private@example.invalid', telegram_id: 'private-telegram-987654321', filename: 'private-family-photo.jpg',
  } };
  assert.deepEqual(await json(await webhook(event)), { status: 'ignored' });
  await json(await refresh(await refreshBody(receipt)));
  // Ensure this assertion observes a working log sink, including an error path.
  await service.request('/v1/challenge', { method: 'POST', bearer: 'invalid-token-for-privacy-test' });
  assert.ok(service.logs.length > 0, 'The local runtime must capture actual Worker logs');
  const rows = [];
  for (const table of ['checkout_claims', 'entitlements', 'entitlement_devices', 'activation_challenges', 'webhook_events']) rows.push(await service.sql(`SELECT * FROM ${table}`));
  const persisted = JSON.stringify(rows);
  const logs = service.logs.join('\n');
  for (const secret of ['payer-private@example.invalid', 'webhook-private@example.invalid', 'private-telegram-987654321', 'private-family-photo.jpg', '192.0.2.123', receipt.claim_secret, receipt.recovery_code, receipt.entitlement_token, service.env.RECOVERY_LOOKUP_KEY, service.env.RECOVERY_ENCRYPTION_KEY, JSON.parse(service.env.ENTITLEMENT_SIGNING_JWK).d]) {
    assert.ok(!persisted.includes(secret), 'D1 must not persist private provider or client material');
    assert.ok(!logs.includes(secret), 'Worker logs must not expose private provider or client material');
  }
  assert.ok(persisted.includes(hash(receipt.owner.encoded)), 'Only the public device identity should be retained');
});
