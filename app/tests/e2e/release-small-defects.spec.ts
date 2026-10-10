import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls, openSettings } from './desktop-fixture';

test('donation badges load locally and retain their wallet destinations', async ({ page }) => {
  await desktopFixture(page, { signedOut: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Donate', exact: true }).click();
  for (const currency of ['LTC', 'BTC']) {
    const image = page.getByRole('img', { name: `Donate ${currency}` });
    await expect(image).toHaveAttribute('src', /^\/.*\.svg$/);
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    await image.click();
  }
  const calls = await nativeCalls(page, 'plugin:shell|open');
  expect(calls.some(call => call.args.path === 'https://link.trustwallet.com/send?address=ltc1q6wkr5ac4u0pxx4hx7xgwn0gsaku25ws0df73rp&asset=c2')).toBe(true);
  expect(calls.some(call => call.args.path === 'https://link.trustwallet.com/send?asset=c0&address=bc1q5pt7m2fk6w0dzsnf6vvd5k6nw5k44785286ujy')).toBe(true);
});

test('supporter terms and fixture PayPal approval still reach the URL opener', async ({ page }) => {
  await desktopFixture(page, { supporterState: 'inactive' });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await openSettings(page);
  await page.getByRole('button', { name: /Lifetime (?:License|license purchased)/ }).click();
  const section = page.locator('#desktop-supporter-section');
  await section.getByRole('button', { name: 'Read full terms', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'plugin:shell|open')).some(call => call.args.path === 'https://example.invalid/terms')).toBe(true);
  await page.evaluate(() => { (window as any).__desktopTest.allowCheckoutFixture = true; });
  await section.getByRole('checkbox').check();
  await section.getByRole('button', { name: 'Get lifetime ad-free · $5', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'plugin:shell|open')).some(call => call.args.path === 'https://www.sandbox.paypal.com/checkoutnow?token=PUBLIC-FIXTURE')).toBe(true);
});


test('storage insights show when their retained inventory is partial', async ({ page }) => {
  await desktopFixture(page);
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Large files', exact: true }).click();
  await expect(page.getByText('1200 indexed results · partial inventory', { exact: true })).toBeVisible();
});
