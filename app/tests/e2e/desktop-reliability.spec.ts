import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

test('a busy account read retries, and an empty cache stays loading until its folder completes', async ({ page }) => {
  await desktopFixture(page, { accountFailures: 100, holdFiles: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Log Out', exact: true })).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_workspace_account')).length).toBeGreaterThan(0);
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__desktopTest.accountFailures = 0; });
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  expect((await nativeCalls(page, 'cmd_workspace_account')).length).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect(page.getByLabel('Loading...', { exact: true })).toBeVisible();
  await expect(page.getByText('No files yet', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__desktopTest.releaseFiles());
  await expect(page.getByText('Holiday saved photo.jpg', { exact: true })).toBeVisible();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toHaveCount(0);
});

test('a delayed old-account folder result cannot replace the new account files', async ({ page }) => {
  await desktopFixture(page, { holdFiles: true });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_files')).length).toBe(1);
  await page.evaluate(() => { (window as any).__desktopTest.owner = '202'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_files')).length).toBe(2);
  await expect(page.getByText('Work saved photo.jpg', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.completedFileRequests.map((request: any) => request.ownerId))).toEqual(['202']);
  await page.evaluate(() => (window as any).__desktopTest.releaseFiles());
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.completedFileRequests.map((request: any) => request.ownerId))).toEqual(['202', '101']);
  // Let the completed old response and streamed event reach React and paint
  // before checking that neither restored the previous account's content.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Work saved photo.jpg', { exact: true })).toBeVisible();
  await expect(page.getByText('Holiday saved photo.jpg', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toHaveCount(0);
});

test('sign-out cancellation and failure preserve files; successful retry clears only Telegram credentials', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  const file = page.getByText('Holiday folder photo.jpg', { exact: true });
  await expect(file).toBeVisible({ timeout: 30_000 });
  const logout = page.getByRole('button', { name: 'Log Out', exact: true });
  await logout.click();
  await page.getByRole('dialog', { name: 'Sign Out' }).getByRole('button', { name: 'Cancel' }).click();
  expect(await nativeCalls(page, 'cmd_logout')).toHaveLength(0);
  await expect(file).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.logoutFails = true; });
  await logout.click();
  await page.getByRole('dialog', { name: 'Sign Out' }).getByRole('button', { name: 'Sign Out', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_logout')).length).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Sign Out' })).toHaveCount(0);
  await expect(page.getByText('The operation could not be completed. Try again or review the related settings.', { exact: true })).toBeVisible();
  await expect(file).toBeVisible();
  expect(await nativeCalls(page, 'cmd_clear_api_hash')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.stores['config.json'].api_id)).toBe('12345');
  await expect(page.getByText('Private native diagnostic', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__desktopTest.logoutFails = false; });
  await logout.click();
  await page.getByRole('dialog', { name: 'Sign Out' }).getByRole('button', { name: 'Sign Out', exact: true }).click();
  await expect(file).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'QR-first secure sign in', exact: true })).toBeVisible();
  const stores = await page.evaluate(() => (window as any).__desktopTest.stores);
  expect(stores['config.json'].api_id).toBeUndefined();
  expect(stores['settings.json'].supporter_activation).toBe('preserve-existing-license');
});

test('settings persist across restart and a failed save can be retried from the application', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await openSettings(page);
  const setting = page.getByRole('combobox', { name: 'Default video upload', exact: true });
  await setting.selectOption('media');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-e2e-stores')!)['settings.json'].settings.videoUploadMode)).toBe('media');
  await page.reload();
  await openSettings(page);
  await expect(setting).toHaveValue('media');
  await page.evaluate(() => { (window as any).__desktopTest.saveFails = true; });
  await setting.selectOption('file');
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__desktopTest.saveFails = false; });
  await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await page.reload();
  await openSettings(page);
  await expect(setting).toHaveValue('file');
});

test('keyboard folder navigation and grid image controls remain usable when dragging is disabled', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  const saved = page.getByRole('button', { name: 'Saved Messages', exact: true });
  await expect(saved).toBeEnabled();
  await saved.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Holiday saved photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recents', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  const card = page.getByRole('group', { name: 'Holiday folder photo.jpg', exact: true });
  await expect(card).toBeEnabled();
  await card.dblclick();
  await expect(page.getByRole('img', { name: 'Holiday folder photo.jpg', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('button', { name: /Current zoom: 125%/ })).toBeVisible();
  await page.getByRole('button', { name: 'Fit image', exact: true }).click();
  await expect(page.getByRole('button', { name: /Current zoom: 100%/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close preview', exact: true })).toHaveCount(0);
});
