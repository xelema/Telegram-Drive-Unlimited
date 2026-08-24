import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types';

const dbMocks = vi.hoisted(() => ({
  discardWebhook: vi.fn(),
  finishWebhook: vi.fn(),
  recordWebhook: vi.fn(),
  revokeEntitlementByCapture: vi.fn(),
  revokeEntitlementByOrder: vi.fn(),
}));

const paypalMocks = vi.hoisted(() => ({
  verifyPayPalWebhook: vi.fn(),
}));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return { ...actual, ...dbMocks };
});

vi.mock('./paypal', async () => {
  const actual = await vi.importActual<typeof import('./paypal')>('./paypal');
  return { ...actual, ...paypalMocks };
});

import worker from './index';

const env = {} as Env;

function webhookRequest(event: unknown): Request {
  return new Request('https://supporter.example/v1/paypal/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function sendWebhook(event: unknown): Promise<Response> {
  return worker.fetch(webhookRequest(event), env);
}

describe('PayPal webhook lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paypalMocks.verifyPayPalWebhook.mockResolvedValue({ status: 'verified' });
    dbMocks.recordWebhook.mockResolvedValue(true);
    dbMocks.finishWebhook.mockResolvedValue(undefined);
    dbMocks.discardWebhook.mockResolvedValue(undefined);
    dbMocks.revokeEntitlementByCapture.mockResolvedValue(true);
    dbMocks.revokeEntitlementByOrder.mockResolvedValue(true);
  });

  it('returns a clear unauthorized response for an invalid signature', async () => {
    paypalMocks.verifyPayPalWebhook.mockResolvedValue({ status: 'invalid', reason: 'signature' });

    const response = await sendWebhook({ id: 'WH-INVALID', event_type: 'PAYMENT.CAPTURE.COMPLETED' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'WEBHOOK_NOT_VERIFIED', message: 'Webhook signature is invalid.' },
    });
    expect(dbMocks.recordWebhook).not.toHaveBeenCalled();
  });

  it('returns a retryable response when PayPal verification is unavailable', async () => {
    paypalMocks.verifyPayPalWebhook.mockResolvedValue({ status: 'unavailable' });

    const response = await sendWebhook({ id: 'WH-OUTAGE', event_type: 'PAYMENT.CAPTURE.COMPLETED' });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'WEBHOOK_VERIFICATION_UNAVAILABLE',
        message: 'PayPal verification is temporarily unavailable. Webhook delivery should be retried.',
      },
    });
    expect(dbMocks.recordWebhook).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing event type', { id: 'WH-MISSING-TYPE' }],
    ['null', null],
    ['an array', []],
    ['a scalar', 'not-a-webhook'],
  ])('rejects invalid webhook data (%s) before signature verification', async (_label, event) => {
    const response = await sendWebhook(event);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INVALID_WEBHOOK', message: 'Invalid webhook payload.' },
    });
    expect(paypalMocks.verifyPayPalWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate event without processing it again', async () => {
    dbMocks.recordWebhook.mockResolvedValue(false);

    const response = await sendWebhook({ id: 'WH-DUPLICATE', event_type: 'UNHANDLED.EVENT' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'duplicate' });
    expect(dbMocks.finishWebhook).not.toHaveBeenCalled();
    expect(dbMocks.discardWebhook).not.toHaveBeenCalled();
  });

  it('discards a failed processing claim so the same event can succeed on retry', async () => {
    dbMocks.finishWebhook
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValueOnce(undefined);
    const event = { id: 'WH-RETRY', event_type: 'UNHANDLED.EVENT' };

    const failedResponse = await sendWebhook(event);
    const retryResponse = await sendWebhook(event);

    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({
      error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Webhook will be retried.' },
    });
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ status: 'ignored' });
    expect(dbMocks.recordWebhook).toHaveBeenCalledTimes(2);
    expect(dbMocks.discardWebhook).toHaveBeenCalledWith(env, 'WH-RETRY');
    expect(dbMocks.finishWebhook).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'refund',
      eventType: 'PAYMENT.CAPTURE.REFUNDED',
      captureId: 'CAPTURE-REFUND',
      resource: { id: 'CAPTURE-REFUND', status: 'COMPLETED' },
    },
    {
      label: 'reversal',
      eventType: 'PAYMENT.CAPTURE.REVERSED',
      captureId: 'CAPTURE-REVERSAL',
      resource: { id: 'CAPTURE-REVERSAL', status: 'COMPLETED' },
    },
    {
      label: 'purchaser-favour dispute',
      eventType: 'CUSTOMER.DISPUTE.RESOLVED',
      captureId: 'CAPTURE-DISPUTE',
      resource: {
        dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' },
        disputed_transactions: [{ seller_transaction_id: 'CAPTURE-DISPUTE' }],
      },
    },
  ])('revokes the matching entitlement after a $label', async ({ eventType, captureId, resource }) => {
    const response = await sendWebhook({ id: `WH-${captureId}`, event_type: eventType, resource });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'revoked' });
    expect(dbMocks.revokeEntitlementByCapture).toHaveBeenCalledWith(
      env,
      captureId,
      eventType.toLowerCase().replaceAll('.', '_'),
      expect.any(Number),
    );
    expect(dbMocks.finishWebhook).toHaveBeenCalledWith(env, `WH-${captureId}`, 'revoked', expect.any(Number));
  });

  it('does not revoke access for a seller-favour dispute', async () => {
    const response = await sendWebhook({
      id: 'WH-SELLER-DISPUTE',
      event_type: 'CUSTOMER.DISPUTE.RESOLVED',
      resource: {
        dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' },
        disputed_transactions: [{ seller_transaction_id: 'CAPTURE-SELLER' }],
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored' });
    expect(dbMocks.revokeEntitlementByCapture).not.toHaveBeenCalled();
    expect(dbMocks.revokeEntitlementByOrder).not.toHaveBeenCalled();
  });
});
