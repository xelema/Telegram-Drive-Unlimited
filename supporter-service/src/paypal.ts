import type { Env, PayPalCapture, PayPalOrder } from './types';

interface CachedAccessToken {
  environment: string;
  value: string;
  expiresAt: number;
}

let cachedAccessToken: CachedAccessToken | null = null;

function apiOrigin(env: Env): string {
  return env.PAYPAL_ENVIRONMENT === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function accessToken(env: Env): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.environment === env.PAYPAL_ENVIRONMENT && cachedAccessToken.expiresAt > Date.now() + 60_000) {
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

export async function verifyPayPalWebhook(env: Env, headers: Headers, rawEvent: string): Promise<boolean> {
  const verificationFields = JSON.stringify({
    auth_algo: headers.get('paypal-auth-algo'),
    cert_url: headers.get('paypal-cert-url'),
    transmission_id: headers.get('paypal-transmission-id'),
    transmission_sig: headers.get('paypal-transmission-sig'),
    transmission_time: headers.get('paypal-transmission-time'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
  });
  const verificationBody = `${verificationFields.slice(0, -1)},"webhook_event":${rawEvent}}`;
  const verification = await paypalRequest<{ verification_status: string }>(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: verificationBody,
  });
  return verification.verification_status === 'SUCCESS';
}
