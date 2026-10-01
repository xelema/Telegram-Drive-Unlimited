import { invoke } from '@tauri-apps/api/core';
import type { TelegramFile } from '../types';
import { DEFAULT_SEARCH_FILTERS, filterAndRankFiles, type FileSearchFilters } from './fileSearch';
import { normalizeListedFile } from './fileListRefresh';

export interface WorkspaceFile extends TelegramFile {
    key: string;
    folder_id: number | null;
    folderName: string;
    tags: string[];
    collectionIds: string[];
}
export interface Collection { id: string; name: string; color: string; icon: string; coverKey: string | null }
export interface SavedSearch {
    id: string; name: string; query: string; filters: FileSearchFilters; tags: string[];
    folderKey?: string | null; collectionId?: string | null; favoritesOnly?: boolean;
}
export interface WorkspaceSnapshot {
    ownerId: string;
    files: WorkspaceFile[];
    collections: Collection[];
    searches: SavedSearch[];
    scans: { folderId: number | null; folderName: string; complete: boolean; updatedAt: number }[];
}
export type WorkspaceMutation =
    | { type: 'save_collection'; collection: Collection }
    | { type: 'remove_collection'; id: string }
    | { type: 'assign'; keys: string[]; collection: string; add: boolean }
    | { type: 'tag'; keys: string[]; tag: string; add: boolean }
    | { type: 'save_search'; search: SavedSearch }
    | { type: 'remove_search'; id: string }
    | { type: 'favorite'; key: string; value: boolean };

function normalize(snapshot: WorkspaceSnapshot, ownerId: string): WorkspaceSnapshot {
    if (snapshot.ownerId !== ownerId) throw new Error('ACCOUNT_CHANGED');
    return { ...snapshot,
        files: snapshot.files.map(file => ({ ...file, ...normalizeListedFile(file) })),
        searches: snapshot.searches.map(search => ({ ...search,
            filters: { ...DEFAULT_SEARCH_FILTERS, ...search.filters }, tags: search.tags ?? [],
            folderKey: search.folderKey ?? null, collectionId: search.collectionId ?? null,
            favoritesOnly: search.favoritesOnly ?? false,
        })),
    };
}
const mutations = new Map<string, Promise<WorkspaceSnapshot>>();
export async function readWorkspace(ownerId: string): Promise<WorkspaceSnapshot> {
    await mutations.get(ownerId)?.catch(() => undefined);
    return normalize(await invoke<WorkspaceSnapshot>('cmd_workspace_read', { ownerId }), ownerId);
}
export function mutateWorkspace(ownerId: string, mutation: WorkspaceMutation): Promise<WorkspaceSnapshot> {
    const operation = (mutations.get(ownerId) ?? Promise.resolve()).catch(() => undefined)
        .then(async () => normalize(await invoke<WorkspaceSnapshot>('cmd_workspace_mutate', { ownerId, mutation }), ownerId));
    mutations.set(ownerId, operation);
    void operation.finally(() => { if (mutations.get(ownerId) === operation) mutations.delete(ownerId); }).catch(() => undefined);
    return operation;
}
export async function indexWorkspace(ownerId: string, folderIds: (number | null)[]): Promise<WorkspaceSnapshot> {
    return normalize(await invoke<WorkspaceSnapshot>('cmd_workspace_index', { ownerId, folderIds }), ownerId);
}
export function savedSearchFolder(search: SavedSearch): number | null | 'all' {
    if (search.folderKey === 'saved') return null;
    if (!search.folderKey) return 'all';
    const id = Number(search.folderKey);
    return Number.isSafeInteger(id) && id > 0 ? id : 'all';
}
export function workspaceFileKey(file: Pick<TelegramFile, 'id' | 'folder_id'>, fallback: number | null = null): string {
    const folder = file.folder_id === undefined ? fallback : file.folder_id;
    return `${folder === null ? 'saved' : folder}:${file.id}`;
}
export function filterWorkspaceFiles(files: WorkspaceFile[], query: string, filters: FileSearchFilters, collection: string | null, tags: string[], folder: number | null | 'all' = 'all'): WorkspaceFile[] {
    const candidates = files.filter(file => (!collection || file.collectionIds.includes(collection))
        && tags.every(tag => file.tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase()))
        && (folder === 'all' || file.folder_id === folder));
    return filterAndRankFiles(candidates, query, filters) as WorkspaceFile[];
}
export function timelineMonth(file: TelegramFile): string {
    const date = new Date(file.created_at || '');
    return Number.isFinite(date.valueOf()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : 'unknown';
}
export function groupTimeline(files: WorkspaceFile[]): { month: string; files: WorkspaceFile[] }[] {
    const groups = new Map<string, WorkspaceFile[]>();
    for (const file of [...files].sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0))) {
        const month = timelineMonth(file);
        const group = groups.get(month);
        if (group) group.push(file);
        else groups.set(month, [file]);
    }
    return [...groups].map(([month, files]) => ({ month, files }));
}

export const ORGANIZE_FILES_EVENT = 'workspace-organize-files';
export function requestFileOrganization(file: TelegramFile, folder: number | null): void {
    window.dispatchEvent(new CustomEvent(ORGANIZE_FILES_EVENT, { detail: { keys: [workspaceFileKey(file, folder)] } }));
}
