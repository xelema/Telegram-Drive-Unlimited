import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, mode: 'hub' | 'gallery') {
    await page.addInitScript(() => {
        const oneDay = 86_400_000;
        const file = (id: number, folder: number | null, name: string) => ({
            id, folder_id: folder, key: `${folder ?? 'saved'}:${id}`, name,
            size: 1024, sizeStr: '1 KB', created_at: new Date(Date.now() - oneDay).toISOString(),
            folderName: folder === null ? 'Saved Messages' : 'Travel', tags: ['Work', 'Receipt'], collectionIds: [],
            mime_type: 'image/jpeg', file_ext: 'jpg', encryption_state: 'plain', is_favorite: folder === null,
        });
        const initial = { ownerId: '1', collections: [], searches: [], scans: [], files: [file(42, null, 'Saved photo.jpg'), file(42, 9, 'Travel photo.jpg'), { ...file(7, 9, 'Invoice.pdf'), mime_type: 'application/pdf', file_ext: 'pdf' }] };
        const state = {
            snapshot: JSON.parse(localStorage.getItem('workspace-ui-test') || JSON.stringify(initial)),
            calls: [] as { command: string; args: any }[],
            galleryFiles: Array.from({ length: 5000 }, (_, index) => ({
                ...file(index % 2500 + 1, index < 2500 ? null : 9, `Photo ${String(index).padStart(5, '0')}.jpg`),
                created_at: new Date(Date.UTC(2026, 8 - Math.floor(index / 500), 15, 12)).toISOString(),
            })),
        };
        const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#1e3a5f"/><circle cx="400" cy="300" r="170" fill="#58a6cc"/></svg>')}`;
        Object.assign(window, {
            __workspaceTest: state,
            __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'macos', platform: 'macos', arch: 'aarch64', version: '15', family: 'unix' },
            __TAURI_INTERNALS__: {
                metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
                convertFileSrc: (path: string) => path,
                invoke: async (command: string, args: any = {}) => {
                    state.calls.push({ command, args });
                    if (command === 'plugin:store|load') return 'settings';
                    if (command === 'plugin:store|get') return [undefined, false];
                    if (command.startsWith('plugin:store|')) return;
                    if (command === 'cmd_workspace_account') return '1';
                    if (command === 'cmd_workspace_asset') return image;
                    if (command === 'cmd_workspace_cancel_asset') return;
                    if (command === 'cmd_workspace_read' || command === 'cmd_workspace_index') return structuredClone(state.snapshot);
                    if (command === 'cmd_workspace_mutate') {
                        const mutation = args.mutation;
                        if (mutation.type === 'save_collection') state.snapshot.collections = [...state.snapshot.collections.filter((item: any) => item.id !== mutation.collection.id), mutation.collection];
                        if (mutation.type === 'remove_collection') {
                            state.snapshot.collections = state.snapshot.collections.filter((item: any) => item.id !== mutation.id);
                            state.snapshot.files.forEach((file: any) => { file.collectionIds = file.collectionIds.filter((id: string) => id !== mutation.id); });
                        }
                        if (mutation.type === 'assign') state.snapshot.files.filter((file: any) => mutation.keys.includes(file.key)).forEach((file: any) => {
                            file.collectionIds = mutation.add ? [...new Set([...file.collectionIds, mutation.collection])] : file.collectionIds.filter((id: string) => id !== mutation.collection);
                        });
                        if (mutation.type === 'tag') state.snapshot.files.filter((file: any) => mutation.keys.includes(file.key)).forEach((file: any) => {
                            file.tags = mutation.add ? [...new Set([...file.tags, mutation.tag])] : file.tags.filter((tag: string) => tag !== mutation.tag);
                        });
                        if (mutation.type === 'save_search') state.snapshot.searches = [...state.snapshot.searches.filter((item: any) => item.id !== mutation.search.id), mutation.search];
                        if (mutation.type === 'remove_search') state.snapshot.searches = state.snapshot.searches.filter((item: any) => item.id !== mutation.id);
                        if (mutation.type === 'favorite') state.snapshot.files.find((file: any) => file.key === mutation.key).is_favorite = mutation.value;
                        localStorage.setItem('workspace-ui-test', JSON.stringify(state.snapshot));
                        return structuredClone(state.snapshot);
                    }
                    if (command === 'cmd_playback_read') return { ownerId: '1', items: [], queue: [], preferences: { volume: 1, speed: 1 } };
                    return null;
                },
            },
        });
    });
    await page.route('**/__workspace_browser**', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="workspace-browser-fixture"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/components/dev/WorkspaceBrowserFixture.tsx"></script></body></html>',
    }));
    await page.goto(`/__workspace_browser?mode=${mode}`);
}

test('collections, covers, tags and editable saved-search rules survive reload', async ({ page }, testInfo) => {
    await fixture(page, 'hub');
    await page.getByRole('button', { name: 'Create collection' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Summer');
    await page.getByRole('combobox', { name: 'Icon', exact: true }).selectOption('plane');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Select Saved photo.jpg', exact: true }).click();
    await page.getByRole('button', { name: 'Select Travel photo.jpg', exact: true }).click();
    await page.getByLabel('Choose collection', { exact: true }).selectOption({ label: 'Summer' });
    await page.getByRole('button', { name: 'Add to collection', exact: true }).click();
    await page.getByLabel('Tag name', { exact: true }).fill('Holiday');
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    await page.getByRole('button', { name: 'Summer', exact: true }).click();
    await page.getByRole('button', { name: 'Select Travel photo.jpg', exact: true }).click();
    await page.getByRole('button', { name: 'Use as album cover' }).click();
    await expect(page.locator('[data-testid^="collection-cover-"] img')).toBeVisible();
    await page.getByLabel('Folders', { exact: true }).selectOption('saved');
    await page.getByLabel('File type', { exact: true }).selectOption('image');
    await page.getByLabel('Size', { exact: true }).selectOption('small');
    await page.getByLabel('Date', { exact: true }).selectOption('30d');
    await page.getByLabel('Tags', { exact: true }).selectOption('Holiday');
    await page.getByLabel('Tags', { exact: true }).selectOption('Work');
    await page.getByLabel('Favorites', { exact: true }).check();
    await page.getByRole('searchbox').fill('photo');
    await page.getByRole('button', { name: 'Save this search', exact: true }).click();
    const editor = page.getByRole('form', { name: 'Save this search', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill('Holiday favorites');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Holiday favorites', exact: true })).toBeVisible();
    const saved = await page.evaluate(() => (window as any).__workspaceTest.snapshot.searches[0]);
    expect(saved).toMatchObject({ folderKey: 'saved', tags: ['Holiday', 'Work'], favoritesOnly: true, query: 'photo', filters: { type: 'image', size: 'small', date: '30d' } });
    expect(saved.collectionId).toBeTruthy();
    await page.reload();
    await page.getByRole('button', { name: 'Holiday favorites', exact: true }).click();
    await expect(page.getByLabel('Folders', { exact: true })).toHaveValue('saved');
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue('30d');
    await expect(page.getByLabel('Favorites', { exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Remove tag filter Holiday' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove tag filter Work' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Saved photo.jpg', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Travel photo.jpg', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit saved search Holiday favorites', exact: true }).click();
    await page.getByRole('form', { name: 'Edit saved search', exact: true }).getByLabel('Name', { exact: true }).fill('Channel photos');
    await page.getByLabel('Folders', { exact: true }).selectOption('9');
    await page.getByLabel('Favorites', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Remove tag filter Work' }).click();
    await page.getByRole('form', { name: 'Edit saved search', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Channel photos', exact: true })).toBeVisible();
    const edited = await page.evaluate(() => (window as any).__workspaceTest.snapshot.searches);
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ id: saved.id, folderKey: '9', tags: ['Holiday'], favoritesOnly: false });
    await expect(page.getByRole('button', { name: 'Open Travel photo.jpg', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('workspace-collections.png'), fullPage: true });
});

test('large gallery keeps virtualization, keyboard menu and composite navigation usable', async ({ page }, testInfo) => {
    await fixture(page, 'gallery');
    const first = page.getByRole('button', { name: 'Open Photo 00000.jpg', exact: true });
    await expect(first).toBeVisible();
    expect(await page.locator('article[data-file-key]').count()).toBeLessThan(100);
    await page.getByRole('button', { name: 'Select Photo 00000.jpg', exact: true }).click();
    await first.focus();
    await first.press('End');
    await expect(page.getByRole('button', { name: 'Open Photo 04999.jpg', exact: true })).toBeFocused();
    expect(await page.locator('article[data-file-key]').count()).toBeLessThan(100);
    await page.getByRole('button', { name: 'Open Photo 04999.jpg', exact: true }).press('Home');
    await expect(first).toBeFocused();
    await page.getByLabel('Jump to month', { exact: true }).selectOption('2026-04');
    await page.getByRole('button', { name: 'Select Photo 02500.jpg', exact: true }).click();
    await expect(page.getByTestId('selected-keys')).toHaveText('saved:1,9:1');
    const menuButton = page.getByRole('button', { name: 'Actions for Photo 02500.jpg', exact: true });
    await menuButton.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Collections & tags' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Open original folder' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menuButton).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('workspace-gallery.png') });
});

test('ordinary image opening stays paused; explicit slideshows advance after image load', async ({ page }) => {
    await page.clock.install();
    await fixture(page, 'gallery');
    await page.getByRole('button', { name: 'Open Photo 00000.jpg', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
    await expect(viewer.getByRole('img', { name: 'Photo 00000.jpg', exact: true })).toBeVisible();
    await page.clock.fastForward(12_000);
    await expect(viewer.getByRole('img', { name: 'Photo 00000.jpg', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Next' }).click();
    await expect(viewer.getByRole('img', { name: 'Photo 00001.jpg', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Start slideshow fixture' }).click();
    const slideshow = page.getByRole('dialog', { name: 'Photo slideshow', exact: true });
    await expect(slideshow.getByRole('img', { name: 'Photo 00000.jpg', exact: true })).toBeVisible();
    await page.clock.fastForward(6000);
    await expect(slideshow.getByRole('img', { name: 'Photo 00001.jpg', exact: true })).toBeVisible();
});

test('narrow gallery and image fullscreen keep controls usable', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, 'gallery');
    const first = page.getByRole('button', { name: 'Open Photo 00000.jpg', exact: true });
    await expect(first).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await first.click();
    const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
    await expect(viewer.getByRole('img', { name: 'Photo 00000.jpg', exact: true })).toBeVisible();
    await viewer.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await expect(viewer).toBeVisible();
    const target = viewer.getByTestId('photo-gesture-area');
    await target.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 330, clientY: 300 }] });
    await target.dispatchEvent('touchend', { changedTouches: [{ identifier: 1, clientX: 40, clientY: 305 }] });
    await expect(viewer.getByRole('img', { name: 'Photo 00001.jpg', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('workspace-mobile-viewer.png') });
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(first).toBeFocused();
});
