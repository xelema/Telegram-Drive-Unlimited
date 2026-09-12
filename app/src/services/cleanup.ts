import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceFile } from './workspace';

export interface Removal {
    id: string; key: string; file: WorkspaceFile; requestedAt: number; deleteAfter: number;
    status: 'pending' | 'deleting' | 'deleted' | 'restored' | 'failed'; error: string | null;
}
export interface CleanupOutcome { key: string; scheduled: boolean; error: string | null }
export function listRemovals(ownerId: string): Promise<Removal[]> { return invoke('cmd_cleanup_list', { ownerId }); }
export function scheduleRemoval(ownerId: string, keys: string[], retentionDays: number): Promise<CleanupOutcome[]> {
    return invoke('cmd_cleanup_schedule', { ownerId, keys, retentionDays });
}
export function restoreRemoval(ownerId: string, key: string): Promise<Removal> { return invoke('cmd_cleanup_restore', { ownerId, key }); }
export function processRemovals(ownerId: string): Promise<Removal[]> { return invoke('cmd_cleanup_process', { ownerId }); }
export type CleanupView = 'duplicates' | 'large' | 'old';
export function cleanupCandidates(files: WorkspaceFile[], view: CleanupView, now = Date.now()): WorkspaceFile[] {
    if (view === 'large') return files.filter(file => file.size >= 100 * 1024 * 1024).sort((a, b) => b.size - a.size);
    if (view === 'old') return files.filter(file => Number.isFinite(Date.parse(file.created_at || '')) && Date.parse(file.created_at!) < now - 365 * 86_400_000).sort((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!));
    const groups = new Map<string, WorkspaceFile[]>();
    for (const file of files) { const key = `${file.name.trim().toLocaleLowerCase()}:${file.size}`; groups.set(key, [...(groups.get(key) || []), file]); }
    return [...groups.values()].filter(group => group.length > 1).flat();
}
