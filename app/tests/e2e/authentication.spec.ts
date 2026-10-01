import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

test('a new desktop session completes phone, code and two-factor recovery and survives restart', async ({ page }) => {
  await desktopFixture(page, { signedOut: true });
  await page.goto('/');
  await page.getByLabel('API ID', { exact: true }).fill('12345');
  await page.getByLabel('API Hash', { exact: true }).fill('fixture-client-hash');
  await page.getByRole('button', { name: 'Continue to QR sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Phone Number', exact: true }).click();
  await page.getByLabel('Phone Number', { exact: true }).fill('+15555550123');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Telegram Code', { exact: true }).fill('12345');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  const password = page.getByLabel('Cloud Password', { exact: true });
  await password.fill('incorrect-fixture-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('Password verification failed.', { exact: true })).toBeVisible();
  await password.fill('correct-fixture-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_store_api_hash')).toHaveLength(1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('desktop-e2e-stores')!)['config.json']);
  expect(stored.api_id).toBe('12345');
  expect(stored.api_hash).toBeUndefined();
  await page.reload();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
});
