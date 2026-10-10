import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

test('Bandwidth controls work without VPN and upload scheduling stays off until chosen', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/'); await openSettings(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('button', { name: /^VPN & network/ }).click();
  await expect(dialog.getByRole('switch', { name: 'VPN Mode', exact: true })).toHaveAttribute('aria-checked', 'false');
  const quota = dialog.getByRole('spinbutton', { name: /Weekly quota/ });
  await expect(quota).toHaveValue('250');
  await quota.fill('128'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_set_weekly_quota')).at(-1)?.args.limitBytes).toBe(128 * 1024 ** 3);
  await expect(dialog.getByRole('slider', { name: /^Download limit/ })).toBeVisible();
  await expect(dialog.getByRole('slider', { name: /^Upload limit/ })).toHaveCount(0);
  const schedule = dialog.getByRole('switch', { name: 'Upload limits and schedule', exact: true });
  await expect(schedule).toHaveAttribute('aria-checked', 'false'); await schedule.click();
  await expect(dialog.getByRole('slider', { name: /^Upload limit/ })).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_apply_vpn_settings')).at(-1)?.args.req.bandwidth_schedule).toBe(true);
  await dialog.getByRole('button', { name: 'Add time window' }).click();
  await dialog.getByRole('checkbox', { name: 'Pause transfers' }).check();
  await dialog.getByLabel('Start time').fill('22:00'); await dialog.getByLabel('End time').fill('06:00');
  await expect.poll(async () => (await nativeCalls(page, 'cmd_apply_vpn_settings')).at(-1)?.args.req.bandwidth_windows[0]).toEqual({ days: [0, 1, 2, 3, 4], start_minute: 1320, end_minute: 360, up_kbs: 0, down_kbs: 0, pause: true });
  await page.reload(); await openSettings(page); await page.getByRole('dialog').getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^VPN & network/ }).click();
  await expect(page.getByRole('spinbutton', { name: /Weekly quota/ })).toHaveValue('128');
  await expect(page.getByRole('checkbox', { name: 'Pause transfers' })).toBeChecked();
  await expect(page.getByLabel('Start time')).toHaveValue('22:00');
  await page.getByRole('button', { name: 'Remove time window' }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_apply_vpn_settings')).at(-1)?.args.req.bandwidth_windows).toEqual([]);
});


test('A failed quota save remains visible and preserves the saved allowance after remount', async ({ page }) => {
  await desktopFixture(page); await page.goto('/'); await openSettings(page);
  let dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Advanced',exact:true}).click(); await dialog.getByRole('button',{name:/^VPN & network/}).click();
  await page.evaluate(()=>{(window as any).__desktopTest.quotaSaveFails=true;});
  await dialog.getByRole('spinbutton',{name:/Weekly quota/}).fill('64'); await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  await page.reload(); await openSettings(page); dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Advanced',exact:true}).click(); await dialog.getByRole('button',{name:/^VPN & network/}).click();
  await expect(dialog.getByRole('spinbutton',{name:/Weekly quota/})).toHaveValue('250');
});
