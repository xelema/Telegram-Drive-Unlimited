import { expect, test, type Page } from '@playwright/test';

async function openGallery(page: Page) {
  await page.goto('/?design-gallery');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('light comfortable LTR gallery', async ({ page }) => {
  await openGallery(page);
  await page.getByRole('group', { name: 'Theme preference' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('main[data-density="comfortable"]')).toHaveScreenshot('gallery-light-comfortable-ltr.png', { fullPage: true });
});

test('dark compact RTL gallery', async ({ page }) => {
  await openGallery(page);
  await page.getByRole('group', { name: 'Theme preference' }).getByRole('button', { name: 'Dark' }).click();
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
  await page.getByRole('group', { name: 'Layout direction' }).getByRole('button', { name: 'RTL' }).click();
  await expect(page.locator('main[data-density="compact"]')).toHaveScreenshot('gallery-dark-compact-rtl.png', { fullPage: true });
});

test('focus treatment remains visible', async ({ page }) => {
  await openGallery(page);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus-visible')).toBeVisible();
  await expect(page.locator('main')).toHaveScreenshot('gallery-keyboard-focus.png', { fullPage: true });
});

test('Japanese CJK strings fit the narrow locale fixture', async ({ page }) => {
  await page.goto('/?design-gallery&locale-stress');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  await page.getByLabel('Audit language').selectOption('ja');
  const card = page.getByTestId('localized-offline-card');
  await expect(card).toContainText('オフラインファイル');
  await expect(card).toContainText('最近開いた暗号化されていないファイル');
  await expect(card).toHaveScreenshot('gallery-japanese-cjk.png');
});
