import { invoke } from '@tauri-apps/api/core';
import type { FileSearchFilters } from './fileSearch';
import type { WorkspaceFile } from './workspace';
import { normalizeListedFile } from './fileListRefresh';
export interface LocalSearchQuery extends Partial<FileSearchFilters> {
    query: string; folderKey?: string | null; tags?: string[]; collectionId?: string | null; favoritesOnly?: boolean;
}
export interface LocalSearchReply {
    files: WorkspaceFile[]; indexId: string; total: number; nextOffset: number | null;
    indexed: boolean; complete: boolean; offline: boolean;
}
export async function searchLocal(ownerId: string, query: LocalSearchQuery, current = () => true): Promise<LocalSearchReply> {
    const deadline = Date.now() + 12 * 60_000;
    for (let attempt = 0; ; attempt++) {
        try {
            let page = await invoke<LocalSearchReply>('cmd_search_local', { ownerId, query: { ...query, offset: 0, limit: 256 } });
            const result = { ...page, files: [...page.files] };
            const offsets = new Set<number>();
            while (page.nextOffset != null && current()) {
                const offset = page.nextOffset;
                if (offsets.has(offset) || result.files.length > 100000) throw new Error('SEARCH_PAGE_INVALID');
                offsets.add(offset);
                page = await invoke<LocalSearchReply>('cmd_search_local', { ownerId, query: { ...query, offset, indexId: result.indexId, limit: 256 } });
                if (page.indexId !== result.indexId || page.total !== result.total || !page.files.length) throw new Error('SEARCH_CHANGED');
                result.files.push(...page.files);
            }
            if (current() && result.files.length !== result.total) throw new Error('SEARCH_PAGE_INVALID');
            return { ...result, nextOffset: null, files: result.files.map(file => ({ ...file, ...normalizeListedFile(file) })) };
        } catch (error) {
            const building = String(error).includes('INVENTORY_BUILDING');
            if (!current() || Date.now() >= deadline || (!building && (attempt >= 2 || !String(error).includes('SEARCH_CHANGED')))) throw error;
            await new Promise(resolve => window.setTimeout(resolve, building ? 2000 : 100));
        }
    }
}
