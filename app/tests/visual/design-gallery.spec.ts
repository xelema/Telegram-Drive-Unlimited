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
  const overflows = await card.evaluate(
    element => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
  );
  expect(overflows, 'Japanese locale fixture should not overflow').toBe(false);
  await expect(card).toHaveScreenshot('gallery-japanese-cjk.png', { maxDiffPixelRatio: 0.04 });
});

test('new regional language strings fit the narrow locale fixture', async ({ page }) => {
  await page.goto('/?design-gallery&locale-stress');
  await expect(page.getByRole('heading', { name: 'Quiet Utility gallery' })).toBeVisible();
  const card = page.getByTestId('localized-offline-card');

  for (const locale of ['bn-BD', 'th-TH', 'fil-PH', 'zh-TW', 'uk-UA', 'pl-PL', 'fa-IR', 'ur-PK', 'ms-MY']) {
    await page.getByLabel('Audit language').selectOption(locale);
    await expect(card).toBeVisible();
    const overflows = await card.evaluate(element => element.scrollWidth > element.clientWidth);
    expect(overflows, `${locale} locale fixture should not overflow`).toBe(false);
  }
});

test('desktop sponsor card renders without external creative dependencies', async ({ page }) => {
  await page.goto('/?design-gallery&sponsor-preview');
  await expect(page.getByRole('heading', { name: 'Sponsor placement preview' })).toBeVisible();

  const banner = page.getByRole('complementary', { name: /Sponsored advertisement/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('A quick message from our sponsor');
  await expect(banner).toContainText('Closes in 10s');

  const layout = await banner.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    fitsHorizontally: element.scrollWidth <= element.clientWidth,
    fitsVertically: element.scrollHeight <= element.clientHeight,
    hasIframe: element.querySelector('iframe') !== null,
  }));
  expect(layout.width).toBe(300);
  expect(layout.fitsHorizontally).toBe(true);
  expect(layout.fitsVertically).toBe(true);
  expect(layout.hasIframe).toBe(false);
});
