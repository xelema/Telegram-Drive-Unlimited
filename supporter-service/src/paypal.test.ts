import { describe, expect, it, vi } from 'vitest';
import { captureAndGetPayPalOrder, validateCompletedOrder } from './paypal';
import { supporterTermsHtml } from './terms';
import { disputeRevokesAccess, relatedPaymentIds } from './index';
import type { Env, PayPalOrder } from './types';

const env = {
  PAYPAL_MERCHANT_ID: 'merchant-123',
  SUPPORTER_PRICE: '5.00',
  SUPPORTER_CURRENCY: 'USD',
  MAX_ACTIVE_DEVICES: '3',
  TERMS_VERSION: '2026-08-11',
} as Env;

function completedOrder(overrides: Partial<PayPalOrder> = {}): PayPalOrder {
  return {
    id: 'ORDER-1',
    status: 'COMPLETED',
    purchase_units: [{
      custom_id: 'claim-1',
      payee: { merchant_id: 'merchant-123' },
      payments: {
        captures: [{
          id: 'CAPTURE-1',
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value: '5.00' },
        }],
      },
    }],
    ...overrides,
  };
}

describe('PayPal order validation', () => {
  it('accepts only the configured claim, merchant, amount, and currency', () => {
    expect(validateCompletedOrder(env, completedOrder(), 'claim-1').id).toBe('CAPTURE-1');
  });

  it.each([
    ['claim', completedOrder(), 'another-claim', 'CLAIM_MISMATCH'],
    ['merchant', completedOrder({ purchase_units: [{ ...completedOrder().purchase_units[0], payee: { merchant_id: 'attacker' } }] }), 'claim-1', 'MERCHANT_MISMATCH'],
    ['amount', completedOrder({ purchase_units: [{ ...completedOrder().purchase_units[0], payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '4.99' } }] } }] }), 'claim-1', 'AMOUNT_MISMATCH'],
  ])('rejects a mismatched %s', (_case, order, claim, expectedError) => {
    expect(() => validateCompletedOrder(env, order as PayPalOrder, claim)).toThrow(expectedError);
  });

  it('reads the canonical order after capture so PayPal metadata is present', async () => {
    const paypalEnv = {
      ...env,
      PAYPAL_ENVIRONMENT: 'sandbox',
      PAYPAL_CLIENT_ID: 'client-id',
      PAYPAL_CLIENT_SECRET: 'client-secret',
    } as Env;
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...completedOrder(),
        purchase_units: [{ payments: completedOrder().purchase_units[0]!.payments }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(completedOrder())));
    vi.stubGlobal('fetch', request);

    try {
      const order = await captureAndGetPayPalOrder(paypalEnv, 'ORDER-1');
      expect(order.purchase_units[0]!.custom_id).toBe('claim-1');
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[1]![0]).toContain('/v2/checkout/orders/ORDER-1/capture');
      expect(request.mock.calls[2]![0]).toContain('/v2/checkout/orders/ORDER-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Supporter terms', () => {
  it('states the activation, refund, revocation, and privacy conditions', () => {
    const terms = supporterTermsHtml(env);
    expect(terms).toContain('Refunds are not automatic and are not guaranteed');
    expect(terms).toContain('refund, payment reversal, chargeback');
    expect(terms).toContain('does not request or store your PayPal email address');
    expect(terms).toContain('up to 3 supported Windows, macOS, Linux, or Android devices');
    expect(terms).toContain('aggregate liability relating to the supporter payment will not exceed the amount paid');
    expect(terms).toContain('does not add IP addresses or raw PayPal webhook payloads');
  });
});

describe('Dispute outcomes', () => {
  it.each(['RESOLVED_BUYER_FAVOUR', 'RESOLVED_BUYER_FAVOR', 'ACCEPTED'])('revokes access for a purchaser-favor outcome: %s', outcome => {
    expect(disputeRevokesAccess({ dispute_outcome: { outcome_code: outcome } })).toBe(true);
  });

  it.each(['RESOLVED_SELLER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'CANCELED_BY_BUYER', 'DENIED', 'NONE'])('preserves access for a seller-favor or neutral outcome: %s', outcome => {
    expect(disputeRevokesAccess({ dispute_outcome: { outcome_code: outcome } })).toBe(false);
  });
});

describe('Webhook payment identifiers', () => {
  it('reads the original capture ID from a refund resource link', () => {
    expect(relatedPaymentIds({
      id: 'REFUND-1',
      status: 'COMPLETED',
      links: [{
        rel: 'up',
        method: 'GET',
        href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123',
      }],
    })).toEqual({ captureId: 'CAPTURE123', orderId: undefined });
  });
});
