import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getAdjacentPreview, previewFileKey } from '../../src/services/previewNavigation';
import type { TelegramFile } from '../../src/types';

const files: TelegramFile[] = [
    { id: 42, folder_id: null, name: 'saved.jpg', size: 1, sizeStr: '1 B' },
    { id: 42, folder_id: 100, name: 'trip.jpg', size: 1, sizeStr: '1 B' },
    { id: 9, folder_id: 200, name: 'work.jpg', size: 1, sizeStr: '1 B' },
];

describe('cross-folder preview navigation', () => {
    it('advances past matching message numbers, and wraps in both directions', () => {
        expect(getAdjacentPreview(files, files[1], 1)).toEqual({ file: files[2], index: 2 });
        expect(getAdjacentPreview(files, files[1], -1)).toEqual({ file: files[0], index: 0 });
        expect(getAdjacentPreview(files, files[2], 1)).toEqual({ file: files[0], index: 0 });
        expect(getAdjacentPreview(files, files[0], -1)).toEqual({ file: files[2], index: 2 });
    });

    it('does not navigate using a number belonging to another peer when current file is missing', () => {
        expect(getAdjacentPreview(files, { ...files[0], folder_id: 999 }, 1)).toBeNull();
        expect(getAdjacentPreview([], files[0], 1)).toBeNull();
        expect(getAdjacentPreview(files, null, -1)).toBeNull();
    });

    it('releases the previous viewer resource when equal message numbers belong to different folders', () => {
        const release = vi.fn();
        function Viewer({ file }: { file: TelegramFile }) {
            useEffect(() => () => release(file.name), []);
            return <p>{file.name}</p>;
        }
        function Gallery() {
            const [file, setFile] = useState(files[0]);
            return <>
                <Viewer key={previewFileKey(file)} file={file} />
                <button onClick={() => setFile(getAdjacentPreview(files, file, 1)!.file)}>Next</button>
            </>;
        }
        render(<Gallery />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('trip.jpg')).toBeTruthy();
        expect(release).toHaveBeenCalledWith('saved.jpg');
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText('work.jpg')).toBeTruthy();
        expect(release).toHaveBeenCalledWith('trip.jpg');
    });
});
