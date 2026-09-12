import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n';
import { ShareDialog } from '../../src/components/desktop/dashboard/ShareDialog';
import { SettingsModal } from '../../src/components/desktop/dashboard/SettingsModal';
import { useFileSharing } from '../../src/hooks/useFileSharing';
import type { ShareInfo, TelegramFile } from '../../src/types';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), nativeShare: vi.fn(), clipboard: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/components/desktop/dashboard/ThemesTab', () => ({ ThemesTab: () => null }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: mocks.confirm }) }));
vi.mock('../../src/context/SettingsContext', async () => {
    const { DEFAULT_SETTINGS } = await import('../../src/config/defaultSettings');
    return { useSettings: () => ({ settings: DEFAULT_SETTINGS, updateSetting: vi.fn(), updateSettings: vi.fn(), resetSettings: vi.fn() }) };
});
vi.mock('../../src/utils', async () => ({ ...(await vi.importActual('../../src/utils')), nativeShareOrCopy: mocks.nativeShare }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: mocks.info } }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const never = () => new Promise<never>(() => undefined);
const file = (name: string, folder_id: number | null | undefined = null): TelegramFile => ({ id: 42, folder_id, name, size: 10, sizeStr: '10 B', type: 'file' });
const share = (owner: string, name = `${owner}-file.txt`): ShareInfo => ({
    id: 'same-share-id', owner_id: owner, folder_id: null, message_id: 42, file_name: name, file_size: 10,
    created_at: 100, expires_at: null, revoked: false, has_password: true, link: `http://127.0.0.1/d/${owner}-private-link`,
});
const generate = () => {
    fireEvent.click(screen.getByRole('button', { name: /Local password link/ }));
    fireEvent.change(screen.getByLabelText(i18n.t('common.password')), { target: { value: 'private-password' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('share.generate_link') }));
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockImplementation(never);
    mocks.confirm.mockResolvedValue(true);
    mocks.clipboard.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard } });
});

describe('account-bound share creation dialog', () => {
    it('discards late create results when a new account opens a file with the same message ID', async () => {
        const a = deferred<ShareInfo>(); const b = deferred<ShareInfo>();
        mocks.invoke.mockImplementation((_command, args) => args.ownerId === 'A' ? a.promise : b.promise);
        const { rerender } = render(<ShareDialog ownerId="A" file={file('A-private.txt')} activeFolderId={900} onClose={vi.fn()} />);
        generate();
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_create_share', expect.objectContaining({ ownerId: 'A', folderId: null, messageId: 42 }));
        rerender(<ShareDialog ownerId="B" file={file('B-private.txt')} activeFolderId={900} onClose={vi.fn()} />);
        expect(screen.queryByDisplayValue('private-password')).toBeNull();
        generate();
        expect(mocks.invoke).toHaveBeenLastCalledWith('cmd_create_share', expect.objectContaining({ ownerId: 'B', folderId: null, messageId: 42 }));
        await act(async () => b.resolve(share('B')));
        await act(async () => a.resolve(share('A')));
        expect(screen.getByDisplayValue(share('B').link)).toBeTruthy();
        expect(screen.queryByDisplayValue(share('A').link)).toBeNull();
    });

    it('does not show an obsolete account error or settle the new account request', async () => {
        const a = deferred<ShareInfo>(); const b = deferred<ShareInfo>();
        mocks.invoke.mockImplementation((_command, args) => args.ownerId === 'A' ? a.promise : b.promise);
        const { rerender } = render(<ShareDialog ownerId="A" file={file('A-private.txt')} onClose={vi.fn()} />);
        generate();
        rerender(<ShareDialog ownerId="B" file={file('B-private.txt')} onClose={vi.fn()} />);
        generate();
        await act(async () => a.reject(new Error('private old-account failure')));
        expect(screen.queryByText(/private old-account failure/)).toBeNull();
        expect((screen.getByRole('button', { name: i18n.t('share.generate_link') }) as HTMLButtonElement).disabled).toBe(true);
        await act(async () => b.resolve(share('B')));
        expect(screen.getByDisplayValue(share('B').link)).toBeTruthy();
    });

    it.each(['A', null])('never adopts a returned link owned by %s into account B', async responseOwner => {
        mocks.invoke.mockResolvedValue({ ...share('A'), owner_id: responseOwner });
        render(<ShareDialog ownerId="B" file={file('B-private.txt')} onClose={vi.fn()} />);
        generate();
        await waitFor(() => expect((screen.getByRole('button', { name: i18n.t('share.generate_link') }) as HTMLButtonElement).disabled).toBe(false));
        expect(screen.queryByDisplayValue(share('A').link)).toBeNull();
        expect(screen.queryByText(i18n.t('share.link_created'))).toBeNull();
    });
});

describe('retained sharing settings across account changes', () => {
    it('filters legacy/foreign records and ignores an older account list that resolves last', async () => {
        const a = deferred<ShareInfo[]>(); const b = deferred<ShareInfo[]>();
        mocks.invoke.mockImplementation((command, args) => command === 'cmd_list_shares' ? (args.ownerId === 'A' ? a.promise : b.promise) : never());
        const { rerender } = render(<SettingsModal ownerId="A" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_shares', { ownerId: 'A' }));
        rerender(<SettingsModal ownerId="B" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_shares', { ownerId: 'B' }));
        await act(async () => b.resolve([share('B'), share('A', 'foreign.txt'), { ...share('A', 'unassigned.txt'), owner_id: null } as never]));
        await act(async () => a.resolve([share('A')]));
        expect(await screen.findByText('B-file.txt')).toBeTruthy();
        expect(screen.queryByText('A-file.txt')).toBeNull();
        expect(screen.queryByText('foreign.txt')).toBeNull();
        expect(screen.queryByText('unassigned.txt')).toBeNull();
    });

    it('does not revoke after the account changes while the confirmation is open', async () => {
        const confirmation = deferred<boolean>();
        mocks.confirm.mockReturnValue(confirmation.promise);
        mocks.invoke.mockImplementation((command, args) => command === 'cmd_list_shares' ? Promise.resolve([share(args.ownerId)]) : never());
        const { rerender } = render(<SettingsModal ownerId="A" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await screen.findByText('A-file.txt');
        fireEvent.click(screen.getByTitle(i18n.t('settings.revoke_link')));
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        rerender(<SettingsModal ownerId="B" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await screen.findByText('B-file.txt');
        await act(async () => confirmation.resolve(true));
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'cmd_revoke_share')).toBe(false);
        expect(screen.getByText('B-file.txt')).toBeTruthy();
    });

    it('does not refresh or announce an old revoke completion under the next account', async () => {
        const revoked = deferred<void>();
        mocks.invoke.mockImplementation((command, args) => command === 'cmd_list_shares' ? Promise.resolve([share(args.ownerId)]) : command === 'cmd_revoke_share' ? revoked.promise : never());
        const { rerender } = render(<SettingsModal ownerId="A" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await screen.findByText('A-file.txt');
        fireEvent.click(screen.getByTitle(i18n.t('settings.revoke_link')));
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_revoke_share', { id: 'same-share-id', ownerId: 'A' }));
        rerender(<SettingsModal ownerId="B" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await screen.findByText('B-file.txt');
        const bLists = mocks.invoke.mock.calls.filter(([command, args]) => command === 'cmd_list_shares' && args.ownerId === 'B').length;
        await act(async () => revoked.resolve());
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.invoke.mock.calls.filter(([command, args]) => command === 'cmd_list_shares' && args.ownerId === 'B')).toHaveLength(bLists);
        expect(screen.getByText('B-file.txt')).toBeTruthy();
    });

    it('clears retained data and stops share listing after logout', async () => {
        mocks.invoke.mockImplementation((command, args) => command === 'cmd_list_shares' ? Promise.resolve([share(args.ownerId)]) : never());
        const { rerender } = render(<SettingsModal ownerId="A" isOpen initialTab="sharing" onClose={vi.fn()} />);
        await screen.findByText('A-file.txt');
        const lists = mocks.invoke.mock.calls.filter(([command]) => command === 'cmd_list_shares').length;
        rerender(<SettingsModal ownerId={null} isOpen initialTab="sharing" onClose={vi.fn()} />);
        expect(screen.queryByText('A-file.txt')).toBeNull();
        await act(async () => undefined);
        expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cmd_list_shares')).toHaveLength(lists);
    });
});

describe('shared desktop/mobile bulk controller', () => {
    it('captures the account and source folder when the file is chosen', () => {
        const { result, rerender } = renderHook(({ owner, folder }) => useFileSharing(owner, folder), { initialProps: { owner: 'A', folder: 7 } });
        const staleChoose = result.current.setShareFile;
        act(() => result.current.setShareFile({ ...file('chosen.txt'), folder_id: undefined }));
        expect(result.current.shareOwnerId).toBe('A');
        expect(result.current.shareFile?.folder_id).toBe(7);
        rerender({ owner: 'A', folder: 9 });
        expect(result.current.shareFile?.folder_id).toBe(7);
        rerender({ owner: 'B', folder: 9 });
        expect(result.current.shareFile).toBeNull();
        act(() => result.current.setShareFile(file('saved.txt', null)));
        expect(result.current.shareOwnerId).toBe('B');
        expect(result.current.shareFile?.folder_id).toBeNull();
        act(() => staleChoose(file('old-A-choice.txt')));
        expect(result.current.shareFile?.name).toBe('saved.txt');
    });

    it('keeps same-ID account B links and selection when an account A bulk result arrives late', async () => {
        const a = deferred<ShareInfo>(); const b = deferred<ShareInfo>();
        mocks.invoke.mockImplementation((_command, args) => args.ownerId === 'A' ? a.promise : b.promise);
        const aSelected = vi.fn(); const bSelected = vi.fn();
        const { result, rerender } = renderHook(({ owner }) => useFileSharing(owner, 900), { initialProps: { owner: 'A' } });
        let aPending!: Promise<void>; let bPending!: Promise<void>;
        act(() => { aPending = result.current.createBulkShares([file('A-private.txt')], aSelected); });
        rerender({ owner: 'B' });
        expect(result.current.bulkShareLinks).toBeNull();
        act(() => { bPending = result.current.createBulkShares([file('B-private.txt')], bSelected); });
        await act(async () => { b.resolve(share('B')); await bPending; });
        await act(async () => { a.resolve(share('A')); await aPending; });
        expect(result.current.bulkShareLinks?.map(value => value.link)).toEqual([share('B').link]);
        expect(aSelected).not.toHaveBeenCalled();
        expect(bSelected).toHaveBeenCalledTimes(1);
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_create_share', expect.objectContaining({ ownerId: 'A', folderId: null, messageId: 42 }));
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_create_share', expect.objectContaining({ ownerId: 'B', folderId: null, messageId: 42 }));
    });

    it('does not reopen a dismissed bulk dialog or copy an old account link', async () => {
        mocks.invoke.mockResolvedValue(share('A'));
        const { result, rerender } = renderHook(({ owner }) => useFileSharing(owner, null), { initialProps: { owner: 'A' } });
        await act(async () => result.current.createBulkShares([file('A-file.txt')], vi.fn()));
        const staleCopy = result.current.handleCopyBulkLink;
        const staleNativeShare = result.current.handleNativeShareBulkLink;
        const staleClose = result.current.setBulkShareLinks;
        rerender({ owner: 'B' });
        staleCopy(share('A').link);
        staleNativeShare(file('A-file.txt'), share('A').link);
        expect(mocks.clipboard).not.toHaveBeenCalled();
        expect(mocks.nativeShare).not.toHaveBeenCalled();
        const pending = deferred<ShareInfo>();
        mocks.invoke.mockReturnValue(pending.promise);
        let action!: Promise<void>;
        act(() => { action = result.current.createBulkShares([file('B-file.txt')], vi.fn()); });
        act(() => staleClose(null));
        expect(result.current.bulkShareLinks).toEqual([]);
        act(() => result.current.setBulkShareLinks(null));
        await act(async () => { pending.resolve(share('B')); await action; });
        expect(result.current.bulkShareLinks).toBeNull();
    });
});
