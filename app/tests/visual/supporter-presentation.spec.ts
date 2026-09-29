import { expect, test } from '@playwright/test';

// Offline fixture. A link may open details; a payment command is never allowed.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        const purchased = new URLSearchParams(location.search).get('license') === 'purchased';
        if (command === 'cmd_get_supporter_status') return {
          state: purchased ? 'active' : 'inactive', ad_free: purchased, message: 'Sponsor messages are enabled.',
          terms_version: '2026-08-11', terms_url: 'https://example.invalid/terms',
          expires_at: Date.now() / 1000 + 86400, offline_until: Date.now() / 1000 + 86400 * 8, recovery_code_saved: purchased, checkout_pending: false,
        };
        throw new Error(`Unavailable fixture command: ${command}`);
      },
    } });
  });
});

for (const locale of ['en', 'de', 'ar', 'ja', 'hi']) {
  test(`weekly offer is centered, readable, and dismissible in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`/?a11y-fixture=supporter&locale=${locale}`);
    await page.locator(`[data-supporter-fixture-ready="${locale}"]`).waitFor();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - 195)).toBeLessThan(2);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - 350)).toBeLessThan(2);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(dialog).not.toContainText('supporter_offer.');
    await expect(dialog.locator('[data-modal-autofocus]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toBeVisible();
    await page.screenshot({ path: `/tmp/telegram-drive-weekly-${locale}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

test('weekly link opens and focuses the existing desktop license section', async ({ page }) => {
  await page.goto('/?a11y-fixture=supporter');
  await page.getByRole('button', { name: 'See supporter details' }).click();
  const section = page.locator('#desktop-supporter-section');
  await expect(section).toBeVisible();
  await expect(section).toBeFocused();
  await expect(section).toContainText('$5');
});

for (const purchase of ['desktop']) {
  for (const locale of ['es', 'ar', 'ja']) {
    test(`${purchase} purchase explanation fits in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: purchase === 'desktop' ? 1000 : 390, height: 800 });
      await page.goto(`/?a11y-fixture=supporter&purchase=${purchase}&locale=${locale}`);
      await page.locator(`[data-supporter-fixture-ready="${locale}"]`).waitFor();
      const content = purchase === 'desktop' ? page.locator('#desktop-supporter-section') : page.locator('main');
      await expect(content).toBeVisible();
      await expect(content).not.toContainText('supporter_license.');
      expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/telegram-drive-purchase-${purchase}-${locale}.png`, fullPage: true });
    });
  }
}

for (const purchase of ['desktop']) {
  test(`${purchase} purchased license is a compact confirmation with recovery details`, async ({ page }) => {
    await page.setViewportSize({ width: purchase === 'desktop' ? 1280 : 390, height: purchase === 'desktop' ? 900 : 800 });
    await page.goto(`/?a11y-fixture=supporter&purchase=${purchase}&license=purchased`);
    await expect(page.getByRole('heading', { name: 'Lifetime license purchased' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get lifetime ad-free · $5' })).toBeHidden();
    await expect(page.getByRole('checkbox')).toBeHidden();
    const details = page.locator('details').filter({ has: page.getByText('License details and recovery', { exact: true }) });
    expect(await details.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
    await page.screenshot({ path: `/tmp/telegram-drive-license-purchased-${purchase}.png`, fullPage: true });
    await details.locator('summary').click();
    await expect(details.getByRole('button', { name: 'Refresh verification' })).toBeVisible();
    await page.screenshot({ path: `/tmp/telegram-drive-license-details-${purchase}.png`, fullPage: true });
  });
}
