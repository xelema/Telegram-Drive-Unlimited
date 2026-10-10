import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

test('password rejection retains its specific error; only a counterfactual false response uses the generic fallback', async ({ page }) => {
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
  await expect(page.getByText('That two-step verification password is incorrect. Check it and try again.', { exact: true })).toBeVisible();
  await expect(page.getByText('The operation could not be completed. Try again or review the related settings.', { exact: true })).toHaveCount(0);
  await expect(password).toBeVisible();
  // This injected response is not evidence that the native backend can return it.
  await password.fill('unsupported-false-response-fixture');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('The operation could not be completed. Try again or review the related settings.', { exact: true })).toBeVisible();
  await password.fill('correct-fixture-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_auth_check_password')).toHaveLength(3);
  expect(await nativeCalls(page, 'cmd_store_api_hash')).toHaveLength(1);
});
