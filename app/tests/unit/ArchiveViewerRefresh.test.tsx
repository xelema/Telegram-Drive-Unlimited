import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveViewerModal } from '../../src/components/desktop/dashboard/ArchiveViewerModal';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlisten: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => mocks.unlisten) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function mountViewer() {
    const client = new QueryClient();
    client.setQueryData(['files', 'folder', 123], []);
    client.setQueryData(['files', 123], []);
    client.setQueryData(['files', 'folder', 999], []);
    const view = render(<QueryClientProvider client={client}>
        <ArchiveViewerModal file={{ id: 42, name: 'archive.zip', size: 1, sizeStr: '1 B' }} activeFolderId={123} folders={[{ id: 123, name: 'Destination' }]} onClose={vi.fn()} />
    </QueryClientProvider>);
    return { ...view, client };
}

describe('archive result refresh', () => {
    beforeEach(() => {
        mocks.invoke.mockReset().mockImplementation((command: string) => {
            if (command === 'cmd_list_archive_contents') return Promise.resolve([{ filename: 'photo.jpg', size: 1, compressed_size: 1, is_dir: false }]);
            if (command === 'cmd_extract_archive_entry') return Promise.resolve({ temp_path: '/tmp/test-entry', filename: 'photo.jpg', size: 1 });
            return Promise.resolve(undefined);
        });
    });

    it('invalidates both desktop and legacy folder keys after a successful entry upload', async () => {
        const { client } = mountViewer();
        const extract = await screen.findByTitle('Extract "photo.jpg" (1 Bytes) to Destination');
        fireEvent.click(extract);
        await waitFor(() => expect(client.getQueryState(['files', 'folder', 123])?.isInvalidated).toBe(true));
        expect(client.getQueryState(['files', 123])?.isInvalidated).toBe(true);
        expect(client.getQueryState(['files', 'folder', 999])?.isInvalidated).toBe(false);
    });

    it('flushes refresh immediately when the viewer closes during debounce', async () => {
        const { client, unmount } = mountViewer();
        const extract = await screen.findByTitle('Extract "photo.jpg" (1 Bytes) to Destination');
        await act(async () => fireEvent.click(extract));
        expect(mocks.invoke).toHaveBeenCalledWith('initiate_upload', expect.objectContaining({ folderId: 123 }));
        expect(client.getQueryState(['files', 'folder', 123])?.isInvalidated).toBe(false);
        unmount();
        expect(client.getQueryState(['files', 'folder', 123])?.isInvalidated).toBe(true);
    });

    it('refreshes a completed per-entry upload whose viewer has already closed', async () => {
        let finishUpload!: () => void;
        const original = mocks.invoke.getMockImplementation()!;
        mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'initiate_upload'
            ? new Promise<void>(resolve => { finishUpload = resolve; })
            : original(command, ...args));
        const { client, unmount } = mountViewer();
        fireEvent.click(await screen.findByTitle('Extract "photo.jpg" (1 Bytes) to Destination'));
        await waitFor(() => expect(finishUpload).toBeTypeOf('function'));
        unmount();
        await act(async () => finishUpload());
        expect(client.getQueryState(['files', 'folder', 123])?.isInvalidated).toBe(true);
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_delete_temp_zip', { path: '/tmp/test-entry' });
    });
});
