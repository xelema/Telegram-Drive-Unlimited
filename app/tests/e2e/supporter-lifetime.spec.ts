import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

for (const supporterState of ['active', 'needs_refresh'] as const) {
  test(`${supporterState} entitlement suppresses ads while loading, after refresh failure, and on restart`, async ({ page }) => {
    await desktopFixture(page, { supporterState, holdSupporter: true });
    await page.goto('/');
    await expect(page.getByText('Checking sponsor access', { exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
    await expect(page.locator('iframe[title="Sponsored"]')).toHaveCount(0);
    await page.evaluate(() => (window as any).__desktopTest.releaseSupporter());
    await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
    await openSettings(page);
    await page.getByRole('button', { name: /Lifetime (?:License|license purchased)/ }).click();
    await expect(page.getByRole('heading', { name: 'Lifetime license purchased' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get lifetime ad-free · $5', exact: true })).toHaveCount(0);
    await page.getByText('License details and recovery', { exact: true }).click();
    await page.evaluate(() => { (window as any).__desktopTest.supporterRefreshFails = true; });
    await page.getByRole('button', { name: 'Refresh verification', exact: true }).click();
    await expect(page.getByText('Unable to reach the supporter service. Check your connection and try again. An existing payment is kept; do not pay again.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lifetime license purchased' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
    expect(await nativeCalls(page, 'cmd_begin_supporter_checkout')).toHaveLength(0);
    await page.reload();
    await page.evaluate(() => (window as any).__desktopTest.releaseSupporter());
    await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
  });
}

test('an expired existing purchase restores ad-free access without a second checkout', async ({ page }) => {
  await desktopFixture(page, { supporterState: 'expired' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openSettings(page);
  await page.getByRole('button', { name: /Lifetime (?:License|license purchased)/ }).click();
  const section = page.locator('#desktop-supporter-section');
  await expect(section).toContainText('do not pay again');
  await expect(section.getByRole('button', { name: 'Get lifetime ad-free · $5', exact: true })).toHaveCount(0);
  await section.getByText('Already supported? Restore with a recovery code', { exact: true }).click();
  await section.getByRole('textbox', { name: 'Recovery code', exact: true }).fill('BROWSER-FIXTURE-NOT-A-REAL-CODE');
  await expect(section.getByRole('button', { name: 'Restore purchase', exact: true })).toBeDisabled();
  await section.getByRole('checkbox').check();
  await section.getByRole('button', { name: 'Restore purchase', exact: true }).click();
  await expect(section.getByRole('heading', { name: 'Lifetime license purchased' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: /Sponsored advertisement/ })).toHaveCount(0);
  expect(await nativeCalls(page, 'cmd_begin_supporter_checkout')).toHaveLength(0);
  expect(await nativeCalls(page, 'cmd_activate_supporter')).toHaveLength(1);
});

test('a free account can browse files and settings before accepting any optional purchase', async ({ page }) => {
  await desktopFixture(page, { supporterState: 'inactive', gatewaySeen: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue to files', exact: true }).click();
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect(page.getByText('Holiday saved photo.jpg', { exact: true })).toBeVisible();
  await openSettings(page);
  await page.getByRole('button', { name: /Lifetime (?:License|license purchased)/ }).click();
  const section = page.locator('#desktop-supporter-section');
  await expect(section).toContainText('$5');
  await expect(section.getByRole('button', { name: 'Get lifetime ad-free · $5', exact: true })).toBeDisabled();
  expect(await nativeCalls(page, 'cmd_begin_supporter_checkout')).toHaveLength(0);
});
