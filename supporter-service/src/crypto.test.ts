import { describe, expect, it } from 'vitest';
import { issueEntitlementToken, verifyEntitlementToken } from './crypto';
import type { EntitlementClaims, Env } from './types';

describe('Supporter entitlement signatures', () => {
  it('accepts Ed25519 JWKs produced with a curve-name algorithm label', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    privateJwk.alg = 'Ed25519';
    const env = { ENTITLEMENT_SIGNING_JWK: JSON.stringify(privateJwk) } as Env;
    const claims: EntitlementClaims = {
      iss: 'telegram-drive-supporter',
      aud: 'telegram-drive-desktop',
      entitlement_id: 'entitlement-1',
      device_key_hash: 'device-1',
      terms_version: '2026-08-11',
      issued_at: 1,
      expires_at: 2,
      offline_until: 3,
    };

    const token = await issueEntitlementToken(env, claims);
    await expect(verifyEntitlementToken(env, token)).resolves.toEqual(claims);
  });
});
