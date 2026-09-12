import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearImageMemoryCaches, getCachedPreview, getCachedThumbnail, loadPreview, loadThumbnail } from '../../src/services/imagePreviewCache';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({invoke,convertFileSrc:(path:string) => `asset://localhost${path}`}));
function deferred<T>() {
    let resolve!: (value:T) => void;
    let reject!: (error:unknown) => void;
    const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;});
    return {promise,resolve,reject};
}
beforeEach(() => {clearImageMemoryCaches();invoke.mockReset();});

describe.each([
    ['preview',loadPreview,getCachedPreview],
    ['thumbnail',loadThumbnail,getCachedThumbnail],
] as const)('%s memory cache account boundary',(_name,load,get) => {
    it('starts a new request for B and cannot restore A after the cache is cleared',async () => {
        const a=deferred<string>(),b=deferred<string>();
        invoke.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const old=load(42,null);
        clearImageMemoryCaches();
        const current=load(42,null);
        expect(invoke).toHaveBeenCalledTimes(2);
        a.resolve('/account-a/private.jpg');
        expect(await old).toBeNull();
        expect(get(42,null)).toBeNull();
        // A's finally handler must not remove B's pending request.
        expect(load(42,null)).toBe(current);
        b.resolve('/account-b/photo.jpg');
        expect(await current).toBe('asset://localhost/account-b/photo.jpg');
        expect(get(42,null)).toBe('asset://localhost/account-b/photo.jpg');
    });

    it('a rejected old request cannot remove the current account request',async () => {
        const a=deferred<string>(),b=deferred<string>();
        invoke.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const old=load(42,9).catch(error => error);
        clearImageMemoryCaches();
        const current=load(42,9);
        a.reject(new Error('ACCOUNT_CHANGED'));
        expect(await old).toEqual(new Error('ACCOUNT_CHANGED'));
        expect(load(42,9)).toBe(current);
        b.resolve('/account-b/photo.jpg');
        await current;
        expect(get(42,9)).toBe('asset://localhost/account-b/photo.jpg');
    });
});
