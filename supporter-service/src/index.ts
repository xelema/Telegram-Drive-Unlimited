import {
  activateDevice,
  beginCheckoutCompletion,
  cleanupExpiredRecords,
  completeCheckout,
  consumeChallenge,
  countActiveDevices,
  createChallenge,
  discardWebhook,
  findEntitlementByRecoveryHash,
  finishWebhook,
  getCheckoutByOrder,
  getCheckoutClaim,
  getDevice,
  getEntitlement,
  insertCheckoutClaim,
  markCheckoutCancelled,
  markCheckoutFailed,
  markCheckoutPending,
  markRecoveryDelivered,
  recordWebhook,
  releaseCheckoutCompletion,
  revokeEntitlementByCapture,
  revokeEntitlementByOrder,
  touchDevice,
} from './db';
import {
  decodeBase64Url,
  decryptRecoveryCode,
  encryptRecoveryCode,
  issueEntitlementToken,
  randomToken,
  recoveryLookupHash,
  sha256,
  signingPublicKey,
  verifyDeviceProof,
  verifyEntitlementToken,
} from './crypto';
import {
  captureAndGetPayPalOrder,
  createPayPalOrder,
  getPayPalOrder,
  validateCompletedOrder,
  verifyPayPalWebhook,
} from './paypal';
import { checkoutResultHtml, supporterTermsHtml } from './terms';
import type { CheckoutClaimRow, EntitlementClaims, Env, PayPalOrder } from './types';

const CHECKOUT_TTL_SECONDS = 30 * 60;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface CheckoutRequest {
  device_public_key?: unknown;
  terms_version?: unknown;
  terms_accepted?: unknown;
  app_version?: unknown;
  platform?: unknown;
}

interface ActivationRequest {
  recovery_code?: unknown;
  device_public_key?: unknown;
  terms_version?: unknown;
  terms_accepted?: unknown;
}

interface RefreshRequest {
  entitlement_token?: unknown;
  challenge_id?: unknown;
  nonce?: unknown;
  signature?: unknown;
}

interface PayPalWebhookEvent {
  id?: unknown;
  event_type?: unknown;
  resource?: Record<string, unknown>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...SECURITY_HEADERS } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });
}

function errorResponse(code: string, status: number, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('CONTENT_TYPE_REQUIRED');
  }
  return request.json() as Promise<T>;
}

async function readRawJson<T>(request: Request): Promise<{ raw: string; parsed: T }> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('CONTENT_TYPE_REQUIRED');
  }
  const raw = await request.text();
  return { raw, parsed: JSON.parse(raw) as T };
}

function validDevicePublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return decodeBase64Url(value).byteLength === 32;
  } catch {
    return false;
  }
}

function acceptedCurrentTerms(env: Env, version: unknown, accepted: unknown): boolean {
  return accepted === true && version === env.TERMS_VERSION;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authorizeClaim(request: Request, claim: CheckoutClaimRow): Promise<boolean> {
  const secret = bearerToken(request);
  return secret !== null && await sha256(secret) === claim.claim_secret_hash;
}

function entitlementClaims(env: Env, entitlementId: string, deviceKeyHash: string, termsVersion: string): EntitlementClaims {
  const issuedAt = nowSeconds();
  const ttl = Number.parseInt(env.ENTITLEMENT_TTL_DAYS, 10) * 86_400;
  const grace = Number.parseInt(env.OFFLINE_GRACE_DAYS, 10) * 86_400;
  return {
    iss: 'telegram-drive-supporter',
    aud: 'telegram-drive-desktop',
    entitlement_id: entitlementId,
    device_key_hash: deviceKeyHash,
    terms_version: termsVersion,
    issued_at: issuedAt,
    expires_at: issuedAt + ttl,
    offline_until: issuedAt + ttl + grace,
  };
}

async function issueActiveToken(env: Env, entitlementId: string, deviceKeyHash: string): Promise<string> {
  const entitlement = await getEntitlement(env, entitlementId);
  const device = await getDevice(env, entitlementId, deviceKeyHash);
  if (!entitlement || entitlement.status !== 'active' || !device || device.revoked_at !== null) {
    throw new Error('ENTITLEMENT_NOT_ACTIVE');
  }
  return issueEntitlementToken(env, entitlementClaims(env, entitlement.id, deviceKeyHash, entitlement.terms_version));
}

function recoveryCode(): string {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const value = Array.from(bytes, byte => characters[byte % characters.length]).join('');
  return value.match(/.{1,5}/g)?.join('-') ?? value;
}

function normalizedRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

async function finalizePaidOrder(env: Env, claim: CheckoutClaimRow, order: PayPalOrder): Promise<CheckoutClaimRow> {
  const current = await getCheckoutClaim(env, claim.id);
  if (current?.status === 'completed') return current;
  const startedAt = nowSeconds();
  if (!await beginCheckoutCompletion(env, claim.id, startedAt)) {
    const latest = await getCheckoutClaim(env, claim.id);
    if (latest?.status === 'completed') return latest;
    throw new Error('CHECKOUT_FINALIZATION_IN_PROGRESS');
  }
  try {
    const processingClaim = await getCheckoutClaim(env, claim.id);
    if (!processingClaim) throw new Error('CHECKOUT_NOT_FOUND');
    const capture = validateCompletedOrder(env, order, claim.id);
    const code = recoveryCode();
    const normalizedCode = normalizedRecoveryCode(code);
    const encrypted = await encryptRecoveryCode(env, code);
    await completeCheckout(env, {
      claim: processingClaim,
      entitlementId: crypto.randomUUID(),
      captureId: capture.id,
      amount: capture.amount.value,
      currency: capture.amount.currency_code,
      recoveryLookupHash: await recoveryLookupHash(env, normalizedCode),
      recoveryCiphertext: encrypted.ciphertext,
      recoveryNonce: encrypted.nonce,
      completedAt: nowSeconds(),
    });
    const completed = await getCheckoutClaim(env, claim.id);
    if (!completed || completed.status !== 'completed') throw new Error('CHECKOUT_FINALIZATION_FAILED');
    return completed;
  } catch (error) {
    await releaseCheckoutCompletion(env, claim.id);
    throw error;
  }
}

async function beginCheckout(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CheckoutRequest>(request);
  if (!validDevicePublicKey(body.device_public_key)) {
    return errorResponse('INVALID_DEVICE_KEY', 400, 'A valid supporter device key is required.');
  }
  if (!acceptedCurrentTerms(env, body.terms_version, body.terms_accepted)) {
    return errorResponse('TERMS_NOT_ACCEPTED', 400, 'Accept the current supporter terms before continuing.');
  }

  const createdAt = nowSeconds();
  const claimId = crypto.randomUUID();
  const claimSecret = randomToken();
  await insertCheckoutClaim(env, {
    id: claimId,
    claim_secret_hash: await sha256(claimSecret),
    device_public_key: body.device_public_key,
    device_key_hash: await sha256(body.device_public_key),
    terms_version: env.TERMS_VERSION,
    terms_accepted_at: createdAt,
    created_at: createdAt,
    expires_at: createdAt + CHECKOUT_TTL_SECONDS,
  });

  try {
    const { order, approvalUrl } = await createPayPalOrder(env, claimId);
    await markCheckoutPending(env, claimId, order.id, approvalUrl);
    return json({
      claim_id: claimId,
      claim_secret: claimSecret,
      approval_url: approvalUrl,
      expires_at: createdAt + CHECKOUT_TTL_SECONDS,
    }, 201);
  } catch (error) {
    await markCheckoutFailed(env, claimId, 'PAYPAL_ORDER_FAILED');
    console.error('Unable to create PayPal order', error);
    return errorResponse('PAYMENT_SERVICE_UNAVAILABLE', 503, 'PayPal checkout is temporarily unavailable. No payment was taken.');
  }
}

async function checkoutStatus(request: Request, env: Env, claimId: string): Promise<Response> {
  const claim = await getCheckoutClaim(env, claimId);
  if (!claim || !await authorizeClaim(request, claim)) return errorResponse('CLAIM_NOT_FOUND', 404, 'Checkout not found.');
  if (claim.status !== 'completed' || !claim.entitlement_id) {
    return json({ status: claim.status, error_code: claim.error_code, expires_at: claim.expires_at });
  }

  const token = await issueActiveToken(env, claim.entitlement_id, claim.device_key_hash);
  let code: string | undefined;
  if (claim.recovery_ciphertext && claim.recovery_nonce) {
    code = await decryptRecoveryCode(env, claim.recovery_ciphertext, claim.recovery_nonce);
    await markRecoveryDelivered(env, claim.id, nowSeconds());
  }
  return json({ status: 'completed', entitlement_token: token, recovery_code: code });
}

async function handleCheckoutReturn(url: URL, env: Env): Promise<Response> {
  const claimId = url.searchParams.get('claim');
  const orderId = url.searchParams.get('token');
  if (!claimId || !orderId) return html(checkoutResultHtml('Checkout could not be verified', 'The payment return link is incomplete. No activation was performed.', false), 400);
  const claim = await getCheckoutClaim(env, claimId);
  if (!claim || claim.paypal_order_id !== orderId) return html(checkoutResultHtml('Checkout could not be verified', 'The payment did not match this activation request.', false), 400);
  try {
    const order = claim.status === 'completed'
      ? await getPayPalOrder(env, orderId)
      : await captureAndGetPayPalOrder(env, orderId);
    await finalizePaidOrder(env, claim, order);
    return html(checkoutResultHtml('Supporter activation confirmed', 'Your payment was verified. Return to Telegram Drive to finish activation and save your recovery code.', true));
  } catch (error) {
    console.error('Unable to complete checkout', error);
    return html(checkoutResultHtml('Activation is still pending', 'Telegram Drive could not verify the completed payment yet. Return to the app and retry; do not submit another payment.', false), 502);
  }
}

async function captureOrReadOrder(env: Env, orderId: string): Promise<PayPalOrder> {
  return captureAndGetPayPalOrder(env, orderId);
}

async function activateWithRecovery(request: Request, env: Env): Promise<Response> {
  const body = await readJson<ActivationRequest>(request);
  if (typeof body.recovery_code !== 'string' || !validDevicePublicKey(body.device_public_key)) {
    return errorResponse('INVALID_ACTIVATION', 400, 'A recovery code and valid device key are required.');
  }
  if (!acceptedCurrentTerms(env, body.terms_version, body.terms_accepted)) {
    return errorResponse('TERMS_NOT_ACCEPTED', 400, 'Accept the current supporter terms before activating a new device.');
  }
  const lookupHash = await recoveryLookupHash(env, normalizedRecoveryCode(body.recovery_code));
  const entitlement = await findEntitlementByRecoveryHash(env, lookupHash);
  if (!entitlement || entitlement.status !== 'active') return errorResponse('RECOVERY_CODE_INVALID', 404, 'Recovery code is invalid or the entitlement is no longer active.');

  const deviceKeyHash = await sha256(body.device_public_key);
  const existingDevice = await getDevice(env, entitlement.id, deviceKeyHash);
  if (!existingDevice || existingDevice.revoked_at !== null) {
    if (await countActiveDevices(env, entitlement.id) >= Number.parseInt(env.MAX_ACTIVE_DEVICES, 10)) {
      return errorResponse('DEVICE_LIMIT_REACHED', 409, `This purchase is already active on ${env.MAX_ACTIVE_DEVICES} devices.`);
    }
  }
  await activateDevice(env, entitlement.id, deviceKeyHash, body.device_public_key, nowSeconds());
  return json({ entitlement_token: await issueActiveToken(env, entitlement.id, deviceKeyHash) });
}

async function createRefreshChallenge(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return errorResponse('TOKEN_REQUIRED', 401, 'An entitlement token is required.');
  const claims = await verifyEntitlementToken(env, token);
  const entitlement = await getEntitlement(env, claims.entitlement_id);
  const device = await getDevice(env, claims.entitlement_id, claims.device_key_hash);
  if (!entitlement || entitlement.status !== 'active' || !device || device.revoked_at !== null) {
    return errorResponse('ENTITLEMENT_NOT_ACTIVE', 403, 'The entitlement or this device is no longer active.');
  }
  const challengeId = crypto.randomUUID();
  const nonce = randomToken();
  await createChallenge(env, challengeId, claims.entitlement_id, claims.device_key_hash, await sha256(nonce), nowSeconds());
  return json({ challenge_id: challengeId, nonce, expires_at: nowSeconds() + 300 });
}

async function refreshEntitlement(request: Request, env: Env): Promise<Response> {
  const body = await readJson<RefreshRequest>(request);
  if (typeof body.entitlement_token !== 'string' || typeof body.challenge_id !== 'string' || typeof body.nonce !== 'string' || typeof body.signature !== 'string') {
    return errorResponse('INVALID_REFRESH', 400, 'The refresh proof is incomplete.');
  }
  const claims = await verifyEntitlementToken(env, body.entitlement_token);
  const device = await getDevice(env, claims.entitlement_id, claims.device_key_hash);
  if (!device || device.revoked_at !== null) return errorResponse('DEVICE_NOT_ACTIVE', 403, 'This device is not active.');
  const message = `telegram-drive-supporter-refresh:${body.challenge_id}:${body.nonce}`;
  if (!await verifyDeviceProof(device.device_public_key, message, body.signature)) {
    return errorResponse('DEVICE_PROOF_INVALID', 403, 'The device proof is invalid.');
  }
  const consumed = await consumeChallenge(env, body.challenge_id, claims.entitlement_id, claims.device_key_hash, await sha256(body.nonce), nowSeconds());
  if (!consumed) return errorResponse('CHALLENGE_INVALID', 409, 'The refresh challenge expired or was already used.');
  await touchDevice(env, claims.entitlement_id, claims.device_key_hash, nowSeconds());
  return json({ entitlement_token: await issueActiveToken(env, claims.entitlement_id, claims.device_key_hash) });
}

function linkedPaymentId(resource: Record<string, unknown>, path: RegExp): string | undefined {
  const links = resource.links as Array<{ href?: unknown }> | undefined;
  for (const link of links ?? []) {
    if (typeof link.href !== 'string') continue;
    const match = link.href.match(path);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function relatedPaymentIds(resource: Record<string, unknown> | undefined): { captureId?: string; orderId?: string } {
  if (!resource) return {};
  const supplementary = resource.supplementary_data as { related_ids?: { capture_id?: unknown; order_id?: unknown } } | undefined;
  const transactions = resource.disputed_transactions as Array<{ seller_transaction_id?: unknown }> | undefined;
  const disputedCaptureId = transactions?.find(transaction => typeof transaction.seller_transaction_id === 'string')?.seller_transaction_id;
  const linkedCaptureId = linkedPaymentId(resource, /\/v2\/payments\/captures\/([A-Z0-9]+)(?:$|[/?#])/i);
  const linkedOrderId = linkedPaymentId(resource, /\/v2\/checkout\/orders\/([A-Z0-9]+)(?:$|[/?#])/i);
  const captureId = typeof supplementary?.related_ids?.capture_id === 'string'
    ? supplementary.related_ids.capture_id
    : typeof disputedCaptureId === 'string' ? disputedCaptureId
    : linkedCaptureId ?? (typeof resource.id === 'string' && typeof resource.status === 'string' ? resource.id : undefined);
  const orderId = typeof supplementary?.related_ids?.order_id === 'string'
    ? supplementary.related_ids.order_id
    : linkedOrderId;
  return { captureId, orderId };
}

export function disputeRevokesAccess(resource: Record<string, unknown> | undefined): boolean {
  const outcome = (resource?.dispute_outcome as { outcome_code?: unknown } | undefined)?.outcome_code;
  return typeof outcome === 'string' && [
    'RESOLVED_BUYER_FAVOUR',
    'RESOLVED_BUYER_FAVOR',
    'ACCEPTED',
  ].includes(outcome);
}

async function processWebhook(request: Request, env: Env): Promise<Response> {
  const { raw, parsed } = await readRawJson<unknown>(request);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResponse('INVALID_WEBHOOK', 400, 'Invalid webhook payload.');
  }
  const event = parsed as PayPalWebhookEvent;
  if (typeof event.id !== 'string' || typeof event.event_type !== 'string') return errorResponse('INVALID_WEBHOOK', 400, 'Invalid webhook payload.');
  const verification = await verifyPayPalWebhook(env, request.headers, raw);
  if (verification.status === 'invalid') return errorResponse('WEBHOOK_NOT_VERIFIED', 401, 'Webhook signature is invalid.');
  if (verification.status === 'unavailable') {
    return errorResponse('WEBHOOK_VERIFICATION_UNAVAILABLE', 503, 'PayPal verification is temporarily unavailable. Webhook delivery should be retried.');
  }
  if (!await recordWebhook(env, event.id, event.event_type, nowSeconds())) return json({ status: 'duplicate' });

  let result = 'ignored';
  try {
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = typeof event.resource?.id === 'string' ? event.resource.id : undefined;
      const claim = orderId ? await getCheckoutByOrder(env, orderId) : null;
      if (claim && claim.status !== 'completed') {
        await finalizePaidOrder(env, claim, await captureOrReadOrder(env, orderId!));
        result = 'activated';
      }
    } else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const { orderId } = relatedPaymentIds(event.resource);
      const claim = orderId ? await getCheckoutByOrder(env, orderId) : null;
      if (claim && claim.status !== 'completed') {
        await finalizePaidOrder(env, claim, await getPayPalOrder(env, orderId!));
        result = 'activated';
      }
    } else if (
      ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(event.event_type)
      || (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED' && disputeRevokesAccess(event.resource))
    ) {
      const { captureId, orderId } = relatedPaymentIds(event.resource);
      const reason = event.event_type.toLowerCase().replaceAll('.', '_');
      const revoked = captureId
        ? await revokeEntitlementByCapture(env, captureId, reason, nowSeconds())
        : orderId ? await revokeEntitlementByOrder(env, orderId, reason, nowSeconds()) : false;
      result = revoked ? 'revoked' : 'not_found';
    }
    await finishWebhook(env, event.id, result, nowSeconds());
    return json({ status: result });
  } catch (error) {
    console.error('Webhook processing failed', event.id, error);
    await discardWebhook(env, event.id);
    return errorResponse('WEBHOOK_PROCESSING_FAILED', 500, 'Webhook will be retried.');
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      status: 'ok',
      terms_version: env.TERMS_VERSION,
      price: env.SUPPORTER_PRICE,
      currency: env.SUPPORTER_CURRENCY,
      max_active_devices: Number.parseInt(env.MAX_ACTIVE_DEVICES, 10),
      entitlement_public_key: signingPublicKey(env),
    });
  }
  if (request.method === 'GET' && url.pathname === '/terms') return html(supporterTermsHtml(env));
  if (request.method === 'POST' && url.pathname === '/v1/checkout') return beginCheckout(request, env);
  const statusMatch = request.method === 'GET' ? url.pathname.match(/^\/v1\/checkout\/([0-9a-f-]+)\/status$/i) : null;
  if (statusMatch?.[1]) return checkoutStatus(request, env, statusMatch[1]);
  if (request.method === 'GET' && url.pathname === '/checkout/return') return handleCheckoutReturn(url, env);
  if (request.method === 'GET' && url.pathname === '/checkout/cancel') {
    const claimId = url.searchParams.get('claim');
    if (claimId) await markCheckoutCancelled(env, claimId);
    return html(checkoutResultHtml('Checkout cancelled', 'No supporter activation was completed.', false));
  }
  if (request.method === 'POST' && url.pathname === '/v1/activate') return activateWithRecovery(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/challenge') return createRefreshChallenge(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/refresh') return refreshEntitlement(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/paypal/webhook') return processWebhook(request, env);
  return errorResponse('NOT_FOUND', 404, 'Endpoint not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      if (code === 'CONTENT_TYPE_REQUIRED') return errorResponse(code, 415, 'Content-Type must be application/json.');
      if (error instanceof SyntaxError) return errorResponse('INVALID_JSON', 400, 'Request body is not valid JSON.');
      console.error('Unhandled supporter service error', error);
      return errorResponse('INTERNAL_ERROR', 500, 'The supporter service could not complete the request.');
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, context: WorkerExecutionContext): Promise<void> {
    context.waitUntil(cleanupExpiredRecords(env, nowSeconds()));
  },
};
