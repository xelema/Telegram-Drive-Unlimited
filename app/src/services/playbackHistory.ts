import { invoke } from '@tauri-apps/api/core';
import type { TelegramFile } from '../types';
import { formatBytes } from '../utils';

export interface PlaybackFile {
    folderId: number | null;
    messageId: number;
    name: string;
    size: number;
    mimeType?: string | null;
    encryptionState: string;
}
export interface PlaybackBookmark { positionMs: number; label: string }
export interface PlaybackRecord extends PlaybackFile {
    mediaId: string;
    ownerId: string;
    positionMs: number;
    durationMs: number;
    completed: boolean;
    volume: number;
    speed: number;
    updatedAt: number;
    bookmarks: PlaybackBookmark[];
}
export interface PlaybackSnapshot {
    ownerId: string;
    items: PlaybackRecord[];
    queue: PlaybackFile[];
    preferences: { volume: number; speed: number };
}
export type PlaybackMutation =
    | { type: 'progress'; file: PlaybackFile; positionMs: number; durationMs: number; volume: number; speed: number }
    | { type: 'finish'; file: PlaybackFile; durationMs: number }
    | { type: 'restart' | 'forget' | 'remove_queue'; file: PlaybackFile }
    | { type: 'bookmark'; file: PlaybackFile; positionMs: number; label: string }
    | { type: 'remove_bookmark'; file: PlaybackFile; positionMs: number }
    | { type: 'enqueue'; files: PlaybackFile[] }
    | { type: 'clear_queue' };

export const PLAYBACK_CHANGED = 'telegram-drive-playback-changed';
export const PLAYBACK_SLEEP_CHANGED = 'telegram-drive-playback-sleep-changed';
const writes = new Map<string, Promise<unknown>>();
const sleepDeadlines = new Map<string, number>();

// A sleep timer applies to this account's listening session, including queued
// files whose player components are remounted. It ends with the application.
export function playbackSleepDeadline(ownerId: string): number | null {
    const deadline = sleepDeadlines.get(ownerId);
    if (!deadline || deadline <= Date.now()) { sleepDeadlines.delete(ownerId); return null; }
    return deadline;
}
export function setPlaybackSleepDeadline(ownerId: string, deadline: number | null): void {
    if (deadline === null) sleepDeadlines.delete(ownerId);
    else sleepDeadlines.set(ownerId, deadline);
    window.dispatchEvent(new CustomEvent(PLAYBACK_SLEEP_CHANGED, { detail: { ownerId } }));
}

export function playbackId(ownerId: string, file: PlaybackFile): string {
    return `${ownerId}:${file.folderId ?? 'saved'}:${file.messageId}`;
}
export function toPlaybackFile(file: TelegramFile, fallback: number | null = null): PlaybackFile {
    return {
        folderId: file.folder_id === undefined ? fallback : file.folder_id,
        messageId: file.id, name: file.name, size: file.size,
        mimeType: file.mime_type, encryptionState: file.encryption_state ?? 'plain',
    };
}
export function fromPlaybackFile(file: PlaybackFile): TelegramFile {
    return {
        id: file.messageId, folder_id: file.folderId, name: file.name,
        size: file.size || 0, sizeStr: formatBytes(file.size || 0),
        mime_type: file.mimeType ?? undefined, type: 'file',
        encryption_state: file.encryptionState as TelegramFile['encryption_state'],
    };
}

function checkOwner(snapshot: PlaybackSnapshot, ownerId: string): PlaybackSnapshot {
    if (!snapshot || snapshot.ownerId !== ownerId) throw new Error('ACCOUNT_CHANGED');
    return snapshot;
}

export async function readPlayback(ownerId: string): Promise<PlaybackSnapshot> {
    // Reopening or switching playback modes must see the final save from the
    // old media element, rather than seek using an earlier persisted position.
    await writes.get(ownerId)?.catch(() => undefined);
    return checkOwner(await invoke<PlaybackSnapshot>('cmd_playback_read', { ownerId }), ownerId);
}

export function mutatePlayback(ownerId: string, mutation: PlaybackMutation): Promise<PlaybackSnapshot> {
    const operation = (writes.get(ownerId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const snapshot = checkOwner(await invoke<PlaybackSnapshot>('cmd_playback_mutate', { ownerId, mutation }), ownerId);
        window.dispatchEvent(new CustomEvent(PLAYBACK_CHANGED, { detail: { ownerId } }));
        return snapshot;
    });
    writes.set(ownerId, operation);
    void operation.finally(() => {
        if (writes.get(ownerId) === operation) writes.delete(ownerId);
    }).catch(() => undefined);
    return operation;
}

export function playbackTime(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
        : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
