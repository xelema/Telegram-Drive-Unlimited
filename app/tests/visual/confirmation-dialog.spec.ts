import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/__confirmation_browser', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="confirmation-fixture"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/components/dev/ConfirmationBrowserFixture.tsx"></script></body></html>` }));
    await page.goto('/__confirmation_browser');
});

test('sign-out confirmation closes and resolves, including repeated use and cancellation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const open = page.getByRole('button', { name: 'Log Out' });
    const dialog = page.getByRole('dialog', { name: 'Sign Out' });
    for (let index = 0; index < 3; index++) {
        await open.focus();
        await open.press('Enter');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Sign Out' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('decisions')).toHaveText(JSON.stringify(Array(index + 1).fill(true)));
        await expect(open).toBeFocused();
    }
    await open.click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('decisions')).toHaveText('[true,true,true,false]');
    await open.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('decisions')).toHaveText('[true,true,true,false,false]');
    expect(errors).toEqual([]);
});

test('unavailable haptic feedback cannot strand sign-out confirmation', async ({ page }) => {
    await page.evaluate(() => Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: () => { throw new DOMException('Device feedback unavailable', 'SecurityError'); },
    }));
    await page.getByRole('button', { name: 'Log Out' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign Out' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Sign Out' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('decisions')).toHaveText('[true]');
});
