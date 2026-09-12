import type { TelegramFile } from '../types';

// Message numbers are unique only inside a Telegram peer. Saved Messages is
// represented by null; include that location in both navigation and React keys.
export function previewFileKey(file: TelegramFile): string {
    return `${file.folder_id ?? 'home'}:${file.id}`;
}

export function samePreviewFile(left: TelegramFile, right: TelegramFile): boolean {
    return previewFileKey(left) === previewFileKey(right);
}

export function getAdjacentPreview(
    files: TelegramFile[],
    current: TelegramFile | null,
    step: 1 | -1,
): { file: TelegramFile; index: number } | null {
    if (!current || files.length === 0) return null;
    const currentIndex = files.findIndex(file => samePreviewFile(file, current));
    if (currentIndex < 0) return null;
    const index = (currentIndex + step + files.length) % files.length;
    return { file: files[index], index };
}
