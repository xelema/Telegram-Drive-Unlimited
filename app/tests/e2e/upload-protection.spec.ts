import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// The real app picker/providers/modal are exercised; native cryptography and
// Telegram delivery are controlled boundaries covered separately by native E2E.
test('protected upload opens vault creation and cancellation never queues a file', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, vaultState: 'none', pickedUploadPaths: ['/fixtures/Holiday.mp4'] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Store & protect/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Create Vault', exact: true })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Default Upload Protection', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nativeCalls(page, 'cmd_transfer_enqueue_many')).toHaveLength(0);
  for (const command of ['cmd_transfer_cancel', 'cmd_transfer_cancel_all', 'cmd_transfer_clear_terminal', 'cmd_transfer_remove', 'cmd_cancel_transfer']) {
    expect(await nativeCalls(page, command)).toHaveLength(0);
  }
});

test('a failed protection dialog reload preserves existing transfers and permits a fresh selection', async ({ page }) => {
  await desktopFixture(page, { encryptionReady: true, populatedTransfers: true, persistTransfersAcrossReload: true, pickedUploadPaths: ['/fixtures/Holiday.mp4'] });
  await page.route('**/components/shared/UploadProtectionDialog.tsx*', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(await nativeCalls(page, 'cmd_transfer_enqueue_many')).toHaveLength(0);
  const jobsBeforeReload = await page.evaluate(async () => {
    const state = (window as any).__desktopTest;
    state.jobs[0] = { ...state.jobs[0], filename: 'Persisted before reload.bin', progress: 61, transferredBytes: 612 };
    await (window as any).__TAURI_INTERNALS__.invoke('cmd_transfer_list', { ownerId: '101' });
    return state.jobs;
  });
  const listCallsBeforeReload = (await nativeCalls(page, 'cmd_transfer_list')).length;
  await page.unroute('**/components/shared/UploadProtectionDialog.tsx*');
  await dialog.getByRole('button', { name: 'Reload app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.jobs)).toEqual(jobsBeforeReload);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_list')).length).toBeGreaterThan(listCallsBeforeReload);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Store Upload normally/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await nativeCalls(page, 'cmd_transfer_enqueue_many')).toHaveLength(0);
  for (const command of ['cmd_transfer_cancel', 'cmd_transfer_cancel_all', 'cmd_transfer_clear_terminal', 'cmd_transfer_remove', 'cmd_cancel_transfer']) {
    expect(await nativeCalls(page, command)).toHaveLength(0);
  }
});
