import { expect, test } from '@playwright/test';
import { desktopFixture } from './desktop-fixture';

/** One-page PDF whose whole page is filled blue; no fonts or external data. */
function bluePagePdf(): string {
  const content = '0 0 1 rg\n0 0 300 200 re\nf\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1').toString('base64');
}

// The document comes from the preview command as fixture bytes; Telegram
// download and range streaming are outside this browser journey.
test('a PDF opens in the built-in viewer and its page is actually drawn', async ({ page }) => {
  await desktopFixture(page, { pdfBase64: bluePagePdf() });
  await page.goto('/');
  await expect(page.getByText('Holiday folder photo.jpg', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Grid', exact: true }).click();
  await page.getByRole('group', { name: 'Fixture report.pdf', exact: true }).hover();
  await page.getByRole('button', { name: 'Preview Fixture report.pdf', exact: true }).click();

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.width || !element.height) return 'not sized';
    const pixel = element.getContext('2d')!.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data;
    return `${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`;
  }), { timeout: 30_000 }).toBe('0,0,255,255');
  await expect(page.getByText('Failed to load PDF document.')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Fixture report.pdf', exact: true })).toBeVisible();
});
