import type { TelegramFile } from '../types';

/** null is an explicit Saved Messages location; only undefined needs context. */
export function sourceFolder(file: Pick<TelegramFile, 'folder_id'> | null | undefined, fallback: number | null): number | null {
    return file?.folder_id === undefined ? fallback : file.folder_id;
}
