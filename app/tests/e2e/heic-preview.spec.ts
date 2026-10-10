import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { desktopFixture, nativeCalls } from './desktop-fixture';
const source = new URL('../../src-tauri/test-support/fixtures/heic/small.heic', import.meta.url);
const jpeg = new URL('../../src-tauri/test-support/fixtures/heic/small-reference.jpg', import.meta.url);
const heicBase64 = readFileSync(source).toString('base64');
const heicJpegBase64 = readFileSync(jpeg).toString('base64');

async function openPhoto(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.HEIC', {exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('button',{name:'Switch to Grid',exact:true}).click();
  await page.getByRole('group',{name:'Holiday folder photo.HEIC',exact:true}).hover();
  await page.getByRole('button',{name:'Preview Holiday folder photo.HEIC',exact:true}).click();
}

// The real application renders the JPEG; decoder/native/Telegram boundaries are controlled here.
test('a HEIC photo displays its JPEG rendition with working zoom and original actions', async ({page}) => {
  await desktopFixture(page,{heicBase64,heicJpegBase64});
  await openPhoto(page);
  const image = page.locator('.viewer-overlay img').last();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img:HTMLImageElement)=>[img.naturalWidth,img.naturalHeight])).toEqual([240,180]);
  await expect(image).toHaveAttribute('src',/^data:image\/jpeg/);
  await page.keyboard.press('+');
  await expect(page.getByRole('button',{name:'Open with External App',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open with External App',exact:true}).click();
  await expect.poll(async () => (await nativeCalls(page,'cmd_open_file_externally')).map(call => call.args.path)).toEqual([`data:image/heic;base64,${heicBase64}`]);
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await expect.poll(async () => (await nativeCalls(page,'plugin:dialog|save')).map(call => call.args.options.defaultPath)).toEqual(['Holiday folder photo.HEIC']);
});

test('a missing HEIC decoder shows translated recovery copy and keeps original actions', async ({page}) => {
  await desktopFixture(page,{heicBase64,heicJpegBase64,heicDecoderMissing:true});
  await openPhoto(page);
  await expect(page.getByText('This preview is unavailable. You can skip it or download the original.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Open with External App',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download',exact:true})).toBeVisible();
  await expect(page.locator('.viewer-overlay img')).toHaveCount(0);
});
