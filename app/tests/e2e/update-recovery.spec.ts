import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';
import { INITIAL_UPDATE_CHECK_DELAY_MS, UPDATE_RECHECK_INTERVAL_MS } from '../../src/services/updatePolicy';

test('an incomplete update leaves the app usable and an install failure can be retried', async ({ page }) => {
  await desktopFixture(page, { update: true });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openSettings(page);
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Settings', exact: true }) });
  await expect(settings.getByRole('button', { name: 'Update & Restart', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { (window as any).__desktopTest.incompleteDownload = true; });
  await settings.getByRole('button', { name: 'Update & Restart', exact: true }).click();
  await expect(page.getByText(/Update verification failed: expected 4 bytes but received 2/)).toBeVisible();
  expect(await nativeCalls(page, 'plugin:updater|install')).toHaveLength(0);
  expect(await nativeCalls(page, 'plugin:process|restart')).toHaveLength(0);
  await page.evaluate(() => { (window as any).__desktopTest.incompleteDownload = false; });
  await settings.getByRole('button', { name: 'Update & Restart', exact: true }).click();
  await expect(page.getByText('Update failed: Disk unavailable', { exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'plugin:updater|install')).toHaveLength(1);
  expect(await nativeCalls(page, 'plugin:process|restart')).toHaveLength(0);
  await page.evaluate(() => { (window as any).__desktopTest.installFails = false; });
  await settings.getByRole('button', { name: 'Update & Restart', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'plugin:process|restart')).length).toBe(1);
  expect(await nativeCalls(page, 'plugin:updater|install')).toHaveLength(2);
});

test('a package-manager installation opens release instructions without downloading an installer', async ({ page }) => {
  await desktopFixture(page, { update: true, packageManaged: true });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('A new version (3.9.6) is available!', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'plugin:opener|open_url')).length).toBe(1);
  expect((await nativeCalls(page, 'plugin:opener|open_url'))[0].args.url).toBe('https://github.com/caamer20/Telegram-Drive/releases/latest');
  expect(await nativeCalls(page, 'plugin:updater|download')).toHaveLength(0);
  expect(await nativeCalls(page, 'plugin:updater|install')).toHaveLength(0);
});

test('a session left running finds a later release without being restarted', async ({ page }) => {
  await page.clock.install();
  await desktopFixture(page);
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.clock.fastForward(INITIAL_UPDATE_CHECK_DELAY_MS + 1_000);
  await expect.poll(async () => (await nativeCalls(page, 'plugin:updater|check')).length).toBe(1);
  await expect(page.getByText('A new version (3.9.6) is available!', { exact: true })).toHaveCount(0);
  // A release is published while the application stays open.
  await page.evaluate(() => { (window as any).__desktopTest.update = true; });
  await page.clock.fastForward(UPDATE_RECHECK_INTERVAL_MS);
  await expect.poll(async () => (await nativeCalls(page, 'plugin:updater|check')).length).toBe(2);
  await expect(page.getByText('A new version (3.9.6) is available!', { exact: true })).toBeVisible();
});

test('automatic update checks stay off when the user disabled them', async ({ page }) => {
  await page.clock.install();
  await desktopFixture(page, { update: true, settings: { autoUpdate: false } });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.clock.fastForward(UPDATE_RECHECK_INTERVAL_MS + INITIAL_UPDATE_CHECK_DELAY_MS);
  expect(await nativeCalls(page, 'plugin:updater|check')).toHaveLength(0);
  await expect(page.getByText('A new version (3.9.6) is available!', { exact: true })).toHaveCount(0);
});
