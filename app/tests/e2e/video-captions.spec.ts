import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

// Drives the application picker, protection choice, and durable queue IPC.
// Telegram send/stream attributes are native code; this controlled boundary
// does not claim a live Telegram or installed Android upload acceptance.
test('original video filename caption preference reaches queued uploads and persists after restart', async ({ page }) => {
  await desktopFixture(page, { pickedUploadPaths: ['/fixtures/Holiday [2026] 🎬.mp4'] });
  await page.goto('/');
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Default video upload', exact: true }).selectOption('media');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-e2e-stores')!)['settings.json'].settings.videoUploadMode)).toBe('media');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Store Upload normally/ }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_enqueue_many')).length).toBe(1);
  let request = (await nativeCalls(page, 'cmd_transfer_enqueue_many'))[0].args.requests[0];
  expect(request).toMatchObject({ filename: 'Holiday [2026] 🎬.mp4', videoUploadMode: 'media', videoFilenameCaption: true, protectionMode: 'standard', ownerId: '101' });
  await openSettings(page);
  const captionSetting = page.getByRole('switch', { name: 'Filename captions', exact: true });
  await expect(captionSetting).toBeChecked();
  await captionSetting.click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-e2e-stores')!)['settings.json'].settings.videoFilenameCaption)).toBe(false);
  await page.reload();
  await openSettings(page);
  await expect(captionSetting).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Store Upload normally/ }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_enqueue_many')).length).toBe(1);
  request = (await nativeCalls(page, 'cmd_transfer_enqueue_many'))[0].args.requests[0];
  expect(request).toMatchObject({ filename: 'Holiday [2026] 🎬.mp4', videoUploadMode: 'media', videoFilenameCaption: false });
});
