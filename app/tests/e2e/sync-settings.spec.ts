import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

// The native planner and scanner are covered by the native journeys. This
// journey covers the controls: what they send, and that they show what is
// stored.
test('Folder Sync settings offer fast scanning and adopting files that are already in both places', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await openSettings(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Folder Sync', exact: true }).click();

  // The scanner is one setting for every mapping, off until chosen.
  const fastScan = page.getByRole('checkbox', { name: 'Skip unchanged files when scanning' });
  await expect(fastScan).not.toBeChecked();
  await expect(page.getByText('Every file is still verified every 6 hours.', { exact: false })).toBeVisible();
  // The control shows the stored value, so it changes once the setting is saved.
  await fastScan.click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_set_sync_scanner')).map(call => call.args)).toEqual([{ scanner: 'incremental', ownerId: '101' }]);
  await expect(fastScan).toBeChecked();
  await fastScan.click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_set_sync_scanner')).at(-1)?.args.scanner).toBe('full');
  await expect(fastScan).not.toBeChecked();

  // Adoption is chosen per mapping, is part of what is previewed, and is
  // saved with the mapping.
  await page.getByRole('button', { name: 'Select a local folder' }).click();
  await page.getByLabel('Select Telegram channel').selectOption({ label: 'Photos' });
  const adopt = page.getByRole('checkbox', { name: 'Treat same-size files already in both places as synced' });
  await expect(adopt).not.toBeChecked();
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_preview_sync_pair')).length).toBe(1);
  expect((await nativeCalls(page, 'cmd_preview_sync_pair'))[0].args.request.preferences.adoptMatchingFiles).toBe(false);
  const save = page.getByRole('button', { name: 'Save paused mapping' });
  await expect(save).toBeEnabled();

  // Changing the choice invalidates the reviewed plan.
  await adopt.check();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_preview_sync_pair')).length).toBe(2);
  expect((await nativeCalls(page, 'cmd_preview_sync_pair'))[1].args.request.preferences).toMatchObject({ adoptMatchingFiles: true, pauseOnConflicts: true, propagateDeletions: false });
  await save.click();
  await expect(page.getByText('Folder mapping saved')).toBeVisible();
  const saved = (await nativeCalls(page, 'cmd_add_sync_pair'))[0].args;
  expect(saved).toMatchObject({ localPath: '/synthetic/Library', channelId: 9, previewToken: 'fixture-review-token', isActive: false });
  expect(saved.preferences.adoptMatchingFiles).toBe(true);

  // Editing the saved mapping shows the stored choice.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(adopt).toBeChecked();
});
