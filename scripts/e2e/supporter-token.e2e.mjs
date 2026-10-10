// A supporter entitlement issued by the Worker is accepted by the application.
//
// The Worker runs in workerd with its real routing, payment verification,
// signing and D1 transactions; only the PayPal transport is simulated. The
// application side is the native driver process running the verification code
// every build ships. Both sides use a key pair generated for this run: the
// production signing key, its public half compiled into releases, and the
// token format are not touched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { day, device, startService, terms } from '../../supporter-service/tests/e2e/local-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = join(root, 'app', 'src-tauri', 'Cargo.toml');
let service;
let driver;
let replies;
let fixture;

before(async () => {
  const build = spawnSync('cargo', ['build', '--locked', '--manifest-path', manifest, '--features', 'native-e2e', '--bin', 'native-e2e-driver'], { stdio: 'inherit' });
  assert.ifError(build.error);
  assert.equal(build.status, 0, 'The native driver must build');
  fixture = mkdtempSync(join(tmpdir(), 'telegram-drive-supporter-token-e2e-'));
  chmodSync(fixture, 0o700);
  writeFileSync(join(fixture, '.native-e2e-fixture'), 'telegram-drive-synthetic-e2e\n');
  const binary = join(root, 'app', 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'native-e2e-driver.exe' : 'native-e2e-driver');
  driver = spawn(binary, [fixture], { stdio: ['pipe', 'pipe', 'inherit'] });
  replies = createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
  assert.deepEqual(JSON.parse((await replies.next()).value), { ready: true });
  service = await startService();
}, { timeout: 900_000 });

after(async () => {
  if (driver) {
    driver.stdin.write(`${JSON.stringify({ command: 'shutdown' })}\n`);
    await new Promise(done => driver.once('exit', done));
  }
  await service?.close();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

async function verify(request) {
  driver.stdin.write(`${JSON.stringify({ command: 'supporter_verify', ...request })}\n`);
  return JSON.parse((await replies.next()).value);
}

test('the application accepts a Worker-issued lifetime entitlement only for its own device and validity window', async () => {
  const owner = device();
  const response = await service.request('/v1/checkout', { method: 'POST', body: {
    device_public_key: owner.encoded, terms_version: terms, terms_accepted: true, app_version: 'e2e', platform: 'desktop',
  }, headers: { 'cf-connecting-ip': '192.0.2.123' } });
  assert.equal(response.status, 201, await response.clone().text());
  const claim = await response.json();
  service.paypal.complete(new URL(claim.approval_url).searchParams.get('token'));
  const receipt = await (await service.request(`/v1/checkout/${claim.claim_id}/status`, { bearer: claim.claim_secret })).json();
  assert.equal(receipt.status, 'completed');

  // The key the Worker publishes is the key the application is built with.
  const health = await (await service.request('/health')).json();
  assert.deepEqual([health.price, health.currency, health.max_active_devices], ['5.00', 'USD', 3]);
  const request = { token: receipt.entitlement_token, devicePublicKey: owner.encoded, servicePublicKey: health.entitlement_public_key };
  const issued = service.verifyToken(receipt.entitlement_token, owner);

  const active = await verify({ ...request, now: issued.issued_at + day });
  assert.deepEqual(active, { ok: true, value: {
    access: 'active', entitlementId: issued.entitlement_id, termsVersion: terms, appTermsVersion: terms,
    expiresAt: issued.expires_at, offlineUntil: issued.offline_until,
  } });
  // The last second of each window, and the first second after it.
  assert.equal((await verify({ ...request, now: issued.expires_at })).value.access, 'active');
  assert.equal((await verify({ ...request, now: issued.expires_at + 1 })).value.access, 'offline_grace');
  assert.equal((await verify({ ...request, now: issued.offline_until })).value.access, 'offline_grace');
  assert.equal((await verify({ ...request, now: issued.offline_until + 1 })).value.access, 'expired');

  // A token is bound to the device it was issued for and to the issuing key.
  assert.deepEqual(await verify({ ...request, now: issued.issued_at, devicePublicKey: device().encoded }),
    { ok: false, error: 'Supporter token belongs to a different device' });
  assert.deepEqual(await verify({ ...request, now: issued.issued_at, servicePublicKey: device().encoded }),
    { ok: false, error: 'Supporter token signature could not be verified' });
  const [header, payload, signature] = receipt.entitlement_token.split('.');
  const extended = Buffer.from(JSON.stringify({ ...issued, offline_until: issued.offline_until + 365 * day })).toString('base64url');
  assert.deepEqual(await verify({ ...request, now: issued.issued_at, token: `${header}.${extended}.${signature}` }),
    { ok: false, error: 'Supporter token signature could not be verified' });
  assert.equal(payload === extended, false);

  // A refreshed token for the same purchase is accepted the same way.
  const challenge = await (await service.request('/v1/challenge', { method: 'POST', bearer: receipt.entitlement_token })).json();
  const { sign } = await import('node:crypto');
  const message = `telegram-drive-supporter-refresh:${challenge.challenge_id}:${challenge.nonce}`;
  const refreshed = await (await service.request('/v1/refresh', { method: 'POST', body: {
    entitlement_token: receipt.entitlement_token, challenge_id: challenge.challenge_id, nonce: challenge.nonce,
    signature: sign(null, Buffer.from(message), owner.privateKey).toString('base64url'),
  } })).json();
  const renewed = await verify({ ...request, token: refreshed.entitlement_token, now: issued.issued_at + day });
  assert.equal(renewed.value.access, 'active');
  assert.equal(renewed.value.entitlementId, issued.entitlement_id);
});
