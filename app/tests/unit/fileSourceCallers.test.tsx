import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { useFileOperations } from '../../src/hooks/useFileOperations';
import { ShareDialog } from '../../src/components/desktop/dashboard/ShareDialog';
import { sourceFolder } from '../../src/services/fileIdentity';
import { filterAndRankFiles, DEFAULT_SEARCH_FILTERS } from '../../src/services/fileSearch';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue('/tmp/downloads') }));
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const file = { id: 42, folder_id: null, name: 'Saved.pdf', size: 1, sizeStr: '1 B' };

describe('source folder contracts at real callers', () => {
    beforeEach(() => invoke.mockReset().mockResolvedValue({ owner_id: 'account-a', link: 'http://127.0.0.1/share/test' }));
    it('uses context only for an absent folder, never Saved Messages', () => {
        expect(sourceFolder(file, 9)).toBeNull();
        expect(sourceFolder({}, 9)).toBe(9);
        expect(sourceFolder(undefined, 9)).toBe(9);
    });
    it('deletes and bulk moves Saved Messages using null after visiting another folder', async () => {
        const client = new QueryClient();
        const { result } = renderHook(() => useFileOperations(9, [42], vi.fn(), [file], undefined, 'account-a'), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
        await act(async () => result.current.handleDelete(file));
        expect(invoke).toHaveBeenCalledWith('cmd_delete_file', { messageId: 42, folderId: null, ownerId: 'account-a' });
        await act(async () => result.current.handleBulkMove(10));
        expect(invoke).toHaveBeenCalledWith('cmd_move_files', { messageIds: [42], sourceFolderId: null, targetFolderId: 10, ownerId: 'account-a' });
    });
    it('keeps each source in the public bulk-download fallback when no queue is supplied', async () => {
        const client = new QueryClient();
        const files = [file,{...file,id:43,name:'Channel.pdf',folder_id:7},{...file,id:44,name:'Context.pdf',folder_id:undefined}];
        const { result } = renderHook(() => useFileOperations(9,[42,43,44],vi.fn(),files,undefined,'account-a'), { wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
        await act(async () => result.current.handleBulkDownload());
        expect(invoke).toHaveBeenCalledWith('cmd_download_file', {req:{message_id:42,save_path:'/tmp/downloads/Saved.pdf',folder_id:null}});
        expect(invoke).toHaveBeenCalledWith('cmd_download_file', {req:{message_id:43,save_path:'/tmp/downloads/Channel.pdf',folder_id:7}});
        expect(invoke).toHaveBeenCalledWith('cmd_download_file', {req:{message_id:44,save_path:'/tmp/downloads/Context.pdf',folder_id:9}});
    });
    it('does not generate a public-channel link or local share against the previous channel', async () => {
        render(<ShareDialog ownerId="account-a" file={file} folders={[{ id: 9, name: 'Public', username: 'public_channel' }]} activeFolderId={9} onClose={vi.fn()} />);
        expect((screen.getByRole('button', { name: /Telegram link/ }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: /Local password link/ }));
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Generate Shareable Link' }));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('cmd_create_share', expect.objectContaining({ folderId: null, messageId: 42 })));
    });
    it('accepts the corrected global-search ISO timestamp in frontend date facets', () => {
        const recent = new Date(Date.now() - 86_400_000).toISOString().replace('Z', '+00:00');
        const old = new Date(Date.now() - 60 * 86_400_000).toISOString().replace('Z', '+00:00');
        const wireFiles = [{ ...file, created_at: recent }, { ...file, id: 43, created_at: old }];
        expect(filterAndRankFiles(wireFiles, 'saved', { ...DEFAULT_SEARCH_FILTERS, scope: 'all', date: '7d' }).map(file => file.id)).toEqual([42]);
    });
});
