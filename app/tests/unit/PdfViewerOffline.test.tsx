import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { PdfViewer } from '../../src/components/desktop/dashboard/PdfViewer';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getDocument: vi.fn(), destroy: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => `asset://localhost${path}` }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: mocks.getDocument }));
vi.mock('../../src/utils', () => ({ isAndroidPlatform: false }));
const file = { id: 42, folder_id: null, name: 'Trip.pdf', size: 1024, sizeStr: '1 KB' };
describe('offline PDF source', () => {
    beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(undefined); mocks.destroy.mockReset(); mocks.getDocument.mockReset(); });
    it('renders from the approved device path and opens that same file externally', async () => {
        mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 0, destroy: mocks.destroy }), destroy: mocks.destroy });
        const { unmount } = render(<PdfViewer file={file} activeFolderId={null} localPath="/offline/Trip.pdf" onClose={vi.fn()} />);
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledWith({ url: 'asset://localhost/offline/Trip.pdf', disableRange: true, disableStream: true, disableAutoFetch: true }));
        expect(mocks.invoke).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Open Natively' }));
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('cmd_open_file_externally', { path: '/offline/Trip.pdf' }));
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        unmount(); expect(mocks.destroy).toHaveBeenCalled();
    });
    it('keeps an unreadable offline PDF local without falling back to a Telegram request', async () => {
        mocks.getDocument.mockReturnValue({ promise: Promise.reject(new Error('Unreadable local PDF')), destroy: mocks.destroy });
        render(<PdfViewer file={file} activeFolderId={null} localPath="/offline/Trip.pdf" onClose={vi.fn()} />);
        await screen.findByText('This preview is unavailable. You can skip it or download the original.');
        expect(mocks.getDocument).toHaveBeenCalledTimes(1);
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});
