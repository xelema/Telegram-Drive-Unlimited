import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
    test(`Download policy ${width}px requires an explicit choice and safely resets`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript(() => { Object.assign(window, { downloadDecisions: [] }); });
        await page.route('**/__collision_browser', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="collision-fixture"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/components/dev/DownloadCollisionBrowserFixture.tsx"></script></body></html>` }));
        await page.goto('/__collision_browser');
        const open = page.getByRole('button', { name: 'Start download' });
        await open.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('radio', { name: /Keep both/ })).toBeChecked();
        await expect(dialog).toBeInViewport();
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => (window as any).downloadDecisions)).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`download-policy-${width}.png`) });
        await dialog.getByRole('radio', { name: /Replace existing files/ }).check();
        await expect(dialog.getByRole('button', { name: 'Download and allow replacement' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Download and allow replacement' }).click();
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).downloadDecisions)).toEqual(['replace']);
        await open.click();
        await expect(dialog.getByRole('radio', { name: /Keep both/ })).toBeChecked();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(open).toBeFocused();
        expect(await page.evaluate(() => (window as any).downloadDecisions)).toEqual(['replace', null]);
    });
}
