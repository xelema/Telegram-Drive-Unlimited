export interface Env {
  DB: D1Database;
  PAYPAL_ENVIRONMENT: 'sandbox' | 'live';
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_MERCHANT_ID: string;
  PAYPAL_WEBHOOK_ID: string;
  PUBLIC_ORIGIN: string;
  SUPPORTER_PRICE: string;
  SUPPORTER_CURRENCY: string;
  MAX_ACTIVE_DEVICES: string;
  TERMS_VERSION: string;
  ENTITLEMENT_TTL_DAYS: string;
  OFFLINE_GRACE_DAYS: string;
  ENTITLEMENT_SIGNING_JWK: string;
  RECOVERY_LOOKUP_KEY: string;
  RECOVERY_ENCRYPTION_KEY: string;
}

export interface CheckoutClaimRow {
  id: string;
  claim_secret_hash: string;
  paypal_order_id: string | null;
  approval_url: string | null;
  device_public_key: string;
  device_key_hash: string;
  status: 'creating' | 'pending' | 'processing' | 'completed' | 'cancelled' | 'expired' | 'failed';
  terms_version: string;
  terms_accepted_at: number;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  processing_started_at: number | null;
  entitlement_id: string | null;
  recovery_ciphertext: string | null;
  recovery_nonce: string | null;
  recovery_delivered_at: number | null;
  error_code: string | null;
}

export interface EntitlementRow {
  id: string;
  paypal_order_id: string;
  paypal_capture_id: string;
  status: 'active' | 'revoked';
  amount: string;
  currency: string;
  recovery_lookup_hash: string;
  terms_version: string;
  created_at: number;
  revoked_at: number | null;
  revocation_reason: string | null;
}

export interface DeviceRow {
  entitlement_id: string;
  device_key_hash: string;
  device_public_key: string;
  activated_at: number;
  last_refreshed_at: number;
  revoked_at: number | null;
}

export interface EntitlementClaims {
  iss: 'telegram-drive-supporter';
  aud: 'telegram-drive-desktop';
  entitlement_id: string;
  device_key_hash: string;
  terms_version: string;
  issued_at: number;
  expires_at: number;
  offline_until: number;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
  payee?: { merchant_id?: string };
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units: Array<{
    custom_id?: string;
    amount?: { currency_code?: string; value?: string };
    payee?: { merchant_id?: string };
    payments?: { captures?: PayPalCapture[] };
  }>;
  links?: Array<{ href: string; rel: string; method: string }>;
}
