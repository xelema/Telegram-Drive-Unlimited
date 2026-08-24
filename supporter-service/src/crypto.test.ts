import { describe, expect, it } from 'vitest';
import { encodeBase64Url, issueEntitlementToken, sha256, verifyEntitlementToken } from './crypto';
import type { EntitlementClaims, Env } from './types';

describe('Supporter entitlement signatures', () => {
  async function signingEnvironment(): Promise<Env> {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    privateJwk.alg = 'Ed25519';
    return { ENTITLEMENT_SIGNING_JWK: JSON.stringify(privateJwk) } as Env;
  }

  async function validClaims(): Promise<EntitlementClaims> {
    return {
      iss: 'telegram-drive-supporter',
      aud: 'telegram-drive-desktop',
      entitlement_id: 'entitlement-1',
      device_key_hash: await sha256('device-public-key'),
      terms_version: '2026-08-11',
      issued_at: 1,
      expires_at: 2,
      offline_until: 3,
    };
  }

  it('accepts Ed25519 JWKs produced with a curve-name algorithm label', async () => {
    const env = await signingEnvironment();
    const claims = await validClaims();

    const token = await issueEntitlementToken(env, claims);
    await expect(verifyEntitlementToken(env, token)).resolves.toEqual(claims);
  });

  it('rejects a valid signature whose entitlement header is not the supported contract', async () => {
    const env = await signingEnvironment();
    const claims = await validClaims();
    const privateJwk = JSON.parse(env.ENTITLEMENT_SIGNING_JWK) as JsonWebKey;
    delete privateJwk.alg;
    const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
    const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'TD-SUPPORTER', kid: 'v1' })));
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(input));
    const token = `${input}.${encodeBase64Url(new Uint8Array(signature))}`;

    await expect(verifyEntitlementToken(env, token)).rejects.toThrow('Invalid entitlement header');
  });

  it('rejects signed claims with a reversed offline validity period', async () => {
    const env = await signingEnvironment();
    const claims = { ...await validClaims(), expires_at: 4, offline_until: 3 };
    await expect(issueEntitlementToken(env, claims)).rejects.toThrow('Invalid entitlement validity period');
  });
});
