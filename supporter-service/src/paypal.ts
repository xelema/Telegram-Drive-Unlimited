import type { Env, PayPalCapture, PayPalOrder } from './types';

interface CachedAccessToken {
  environment: string;
  clientId: string;
  value: string;
  expiresAt: number;
}

interface WebhookVerificationFields {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
}

export type PayPalWebhookVerification =
  | { status: 'verified' }
  | { status: 'invalid'; reason: 'headers' | 'event' | 'signature' }
  | { status: 'unavailable' };

let cachedAccessToken: CachedAccessToken | null = null;

function apiOrigin(env: Env): string {
  return env.PAYPAL_ENVIRONMENT === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function accessToken(env: Env): Promise<string> {
  if (
    cachedAccessToken
    && cachedAccessToken.environment === env.PAYPAL_ENVIRONMENT
    && cachedAccessToken.clientId === env.PAYPAL_CLIENT_ID
    && cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.value;
  }

  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const response = await fetch(`${apiOrigin(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status})`);
  const body = await response.json<{ access_token: string; expires_in: number }>();
  cachedAccessToken = {
    environment: env.PAYPAL_ENVIRONMENT,
    clientId: env.PAYPAL_CLIENT_ID,
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, body.expires_in) * 1000,
  };
  return body.access_token;
}

async function paypalRequest<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiOrigin(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken(env)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const debugId = response.headers.get('paypal-debug-id');
    throw new Error(`PayPal request failed (${response.status}${debugId ? `, ${debugId}` : ''})`);
  }
  return response.json<T>();
}

export async function createPayPalOrder(env: Env, claimId: string): Promise<{ order: PayPalOrder; approvalUrl: string }> {
  const order = await paypalRequest<PayPalOrder>(env, '/v2/checkout/orders', {
    method: 'POST',
    headers: {
      'PayPal-Request-Id': `telegram-drive-${claimId}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: 'telegram-drive-supporter',
        custom_id: claimId,
        description: 'Telegram Drive one-time ad-free supporter activation',
        amount: { currency_code: env.SUPPORTER_CURRENCY, value: env.SUPPORTER_PRICE },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Telegram Drive',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: `${env.PUBLIC_ORIGIN}/checkout/return?claim=${encodeURIComponent(claimId)}`,
            cancel_url: `${env.PUBLIC_ORIGIN}/checkout/cancel?claim=${encodeURIComponent(claimId)}`,
          },
        },
      },
    }),
  });
  const approvalUrl = order.links?.find(link => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  if (!approvalUrl) throw new Error('PayPal did not return an approval URL');
  return { order, approvalUrl };
}

export async function capturePayPalOrder(env: Env, orderId: string): Promise<PayPalOrder> {
  return paypalRequest<PayPalOrder>(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `telegram-drive-capture-${orderId}` },
    body: '{}',
  });
}

export async function getPayPalOrder(env: Env, orderId: string): Promise<PayPalOrder> {
  return paypalRequest<PayPalOrder>(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

export async function captureAndGetPayPalOrder(env: Env, orderId: string): Promise<PayPalOrder> {
  try {
    await capturePayPalOrder(env, orderId);
  } catch {
    // PayPal rejects a second capture after an order has already completed.
  }
  return getPayPalOrder(env, orderId);
}

export function validateCompletedOrder(env: Env, order: PayPalOrder, expectedClaimId: string): PayPalCapture {
  const purchaseUnit = order.purchase_units[0];
  const capture = purchaseUnit?.payments?.captures?.find(candidate => candidate.status === 'COMPLETED');
  if (order.status !== 'COMPLETED' || !purchaseUnit || !capture) throw new Error('PAYMENT_NOT_COMPLETED');
  if (purchaseUnit.custom_id !== expectedClaimId) throw new Error('CLAIM_MISMATCH');
  if (capture.payee?.merchant_id !== env.PAYPAL_MERCHANT_ID && purchaseUnit.payee?.merchant_id !== env.PAYPAL_MERCHANT_ID) {
    throw new Error('MERCHANT_MISMATCH');
  }
  if (capture.amount.currency_code !== env.SUPPORTER_CURRENCY || capture.amount.value !== env.SUPPORTER_PRICE) {
    throw new Error('AMOUNT_MISMATCH');
  }
  return capture;
}

function boundedHeader(headers: Headers, name: string, maximumLength: number): string | null {
  const value = headers.get(name);
  if (!value || value.length > maximumLength || /\s/.test(value)) return null;
  return value;
}

function allowedCertificateUrl(env: Env, value: string): boolean {
  try {
    const url = new URL(value);
    const expectedHosts = env.PAYPAL_ENVIRONMENT === 'live'
      ? new Set(['api-m.paypal.com', 'api.paypal.com'])
      : new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);
    return url.protocol === 'https:'
      && expectedHosts.has(url.hostname)
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && url.pathname.startsWith('/v1/notifications/certs/');
  } catch {
    return false;
  }
}

export function validatedWebhookVerificationFields(env: Env, headers: Headers): WebhookVerificationFields | null {
  const authAlgo = boundedHeader(headers, 'paypal-auth-algo', 100);
  const certUrl = boundedHeader(headers, 'paypal-cert-url', 500);
  const transmissionId = boundedHeader(headers, 'paypal-transmission-id', 50);
  const transmissionSig = boundedHeader(headers, 'paypal-transmission-sig', 500);
  const transmissionTime = boundedHeader(headers, 'paypal-transmission-time', 100);
  const webhookId = env.PAYPAL_WEBHOOK_ID;

  if (
    authAlgo !== 'SHA256withRSA'
    || !certUrl
    || !allowedCertificateUrl(env, certUrl)
    || !transmissionId
    || /^\d+$/.test(transmissionId)
    || !transmissionSig
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(transmissionSig)
    || !transmissionTime
    || !Number.isFinite(Date.parse(transmissionTime))
    || !/^[A-Za-z0-9_-]{1,50}$/.test(webhookId)
  ) {
    return null;
  }

  return {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
  };
}

export async function verifyPayPalWebhook(
  env: Env,
  headers: Headers,
  rawEvent: string,
): Promise<PayPalWebhookVerification> {
  const verificationFields = validatedWebhookVerificationFields(env, headers);
  if (!verificationFields) return { status: 'invalid', reason: 'headers' };

  try {
    const webhookEvent = JSON.parse(rawEvent) as unknown;
    if (!webhookEvent || typeof webhookEvent !== 'object' || Array.isArray(webhookEvent)) {
      return { status: 'invalid', reason: 'event' };
    }
  } catch {
    return { status: 'invalid', reason: 'event' };
  }

  // PayPal verifies the event bytes sent by the webhook. Build only the outer
  // verification envelope so the original event text is inserted unchanged.
  const fieldsJson = JSON.stringify(verificationFields);
  const verificationBody = `${fieldsJson.slice(0, -1)},\"webhook_event\":${rawEvent}}`;

  try {
    const verification = await paypalRequest<{ verification_status: string }>(
      env,
      '/v1/notifications/verify-webhook-signature',
      { method: 'POST', body: verificationBody },
    );
    return verification.verification_status === 'SUCCESS'
      ? { status: 'verified' }
      : { status: 'invalid', reason: 'signature' };
  } catch {
    return { status: 'unavailable' };
  }
}
