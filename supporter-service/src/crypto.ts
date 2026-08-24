import type { EntitlementClaims, Env } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENTITLEMENT_HEADER = { alg: 'EdDSA', typ: 'TD-SUPPORTER', kid: 'v1' } as const;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function importHmacKey(encodedKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    decodeBase64Url(encodedKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function recoveryLookupHash(env: Env, recoveryCode: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(env.RECOVERY_LOOKUP_KEY), encoder.encode(recoveryCode));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function encryptRecoveryCode(env: Env, recoveryCode: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await crypto.subtle.importKey('raw', decodeBase64Url(env.RECOVERY_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(recoveryCode));
  return { ciphertext: encodeBase64Url(new Uint8Array(ciphertext)), nonce: encodeBase64Url(nonce) };
}

export async function decryptRecoveryCode(env: Env, ciphertext: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeBase64Url(env.RECOVERY_ENCRYPTION_KEY), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64Url(nonce) },
    key,
    decodeBase64Url(ciphertext),
  );
  return decoder.decode(plaintext);
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const jwk = JSON.parse(env.ENTITLEMENT_SIGNING_JWK) as JsonWebKey;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) {
    throw new Error('Entitlement signing key is invalid');
  }
  // WebCrypto expects the JOSE algorithm name (EdDSA), while some key
  // generators label Ed25519 JWKs with the curve name. The field is optional.
  delete jwk.alg;
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
}

async function verificationKey(env: Env): Promise<CryptoKey> {
  const privateJwk = JSON.parse(env.ENTITLEMENT_SIGNING_JWK) as JsonWebKey;
  const publicJwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, ext: true };
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify']);
}

export async function issueEntitlementToken(env: Env, claims: EntitlementClaims): Promise<string> {
  validateEntitlementClaims(claims);
  const header = encodeBase64Url(encoder.encode(JSON.stringify(ENTITLEMENT_HEADER)));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(env), encoder.encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyEntitlementToken(env: Env, token: string): Promise<EntitlementClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('Malformed entitlement token');
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    await verificationKey(env),
    decodeBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Invalid entitlement signature');

  const header = JSON.parse(decoder.decode(decodeBase64Url(parts[0]))) as Record<string, unknown>;
  if (
    !header
    || header.alg !== ENTITLEMENT_HEADER.alg
    || header.typ !== ENTITLEMENT_HEADER.typ
    || header.kid !== ENTITLEMENT_HEADER.kid
  ) {
    throw new Error('Invalid entitlement header');
  }
  const claims = JSON.parse(decoder.decode(decodeBase64Url(parts[1]))) as EntitlementClaims;
  validateEntitlementClaims(claims);
  return claims;
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validUnixSecond(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateEntitlementClaims(claims: EntitlementClaims): void {
  if (!claims || claims.iss !== 'telegram-drive-supporter' || claims.aud !== 'telegram-drive-desktop') {
    throw new Error('Invalid entitlement audience');
  }
  if (
    !validNonEmptyString(claims.entitlement_id)
    || !validNonEmptyString(claims.terms_version)
    || !validNonEmptyString(claims.device_key_hash)
  ) {
    throw new Error('Invalid entitlement claims');
  }
  try {
    if (decodeBase64Url(claims.device_key_hash).byteLength !== 32) throw new Error();
  } catch {
    throw new Error('Invalid entitlement device binding');
  }
  if (
    !validUnixSecond(claims.issued_at)
    || !validUnixSecond(claims.expires_at)
    || !validUnixSecond(claims.offline_until)
    || claims.issued_at > claims.expires_at
    || claims.expires_at > claims.offline_until
  ) {
    throw new Error('Invalid entitlement validity period');
  }
}

export async function verifyDeviceProof(publicKey: string, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', decodeBase64Url(publicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, decodeBase64Url(signature), encoder.encode(message));
}

export function signingPublicKey(env: Env): string {
  const jwk = JSON.parse(env.ENTITLEMENT_SIGNING_JWK) as JsonWebKey;
  if (!jwk.x) throw new Error('Signing public key is missing');
  return jwk.x;
}
