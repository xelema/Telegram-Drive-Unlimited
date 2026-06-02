import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFolder, FolderInviteInfo } from '../types';
import { useNetworkStatus } from './useNetworkStatus';

export function useTelegramConnection(onLogoutParent: () => void) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();

    const [folders, setFolders] = useState<TelegramFolder[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
    const [store, setStore] = useState<Store | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(true);


    const networkIsOnline = useNetworkStatus();

    // Ref to always point to the latest handleSyncFolders without triggering effect re-runs.
    // Initialized as null then assigned after handleSyncFolders is declared below.
    const handleSyncFoldersRef = useRef<((silentParam?: boolean | unknown) => Promise<void>) | null>(null);

    // Load persisted store and restore saved folders.
    // NOTE: The Telegram connection is already established by App.tsx before
    // Dashboard mounts, so we do NOT call cmd_connect here. This prevents
    // duplicate network runners and race conditions in the Rust backend.
    useEffect(() => {
        const initStore = async () => {
            try {
                let _store = await load('config.json');
                const checkId = await _store.get<string>('api_id');
                if (!checkId) {
                    _store = await load('settings.json');
                }
                setStore(_store);

                const savedFolders = await _store.get<TelegramFolder[]>('folders');
                if (savedFolders) setFolders(savedFolders);

                const savedActiveFolderId = await _store.get<number | null>('activeFolderId');
                if (savedActiveFolderId !== undefined) setActiveFolderId(savedActiveFolderId);

                // Connection is already live — just mark connected and refresh files
                setIsConnected(true);
                queryClient.invalidateQueries({ queryKey: ['files'] });
            } catch {
                // store not available
            }
        };
        initStore();
    }, [queryClient]);

    // Consolidated mount-sync + visibility-change listener in a single effect.
    // Previously two effects with identical [store, isConnected] deps both called
    // handleSyncFolders + queryClient.invalidateQueries, causing doubled startup work.
    useEffect(() => {
        if (!store || !isConnected) return;

        const syncAndRefresh = async () => {
            if (!handleSyncFoldersRef.current) return;
            await handleSyncFoldersRef.current(true);
            queryClient.invalidateQueries({ queryKey: ['files'] });
        };

        // Initial sync on mount / when store becomes available
        syncAndRefresh();

        // Sync again when the app returns to foreground
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                syncAndRefresh();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [store, isConnected, queryClient]);


    useEffect(() => {
        setIsConnected(networkIsOnline);
    }, [networkIsOnline]);


    const handleLogout = async () => {
        if (!await confirm({ title: "Sign Out", message: "Are you sure you want to sign out? This will disconnect your active session.", confirmText: "Sign Out", variant: 'danger' })) return;

        try {
            await invoke('cmd_logout');
            await invoke('cmd_clean_cache');
            if (store) {
                await store.delete('api_id');
                await store.delete('api_hash');
                await store.delete('folders');
                await store.save();
            }
            onLogoutParent();
        } catch {
            toast.error("Error signing out");
            onLogoutParent();
        }
    };

    const handleSyncFolders = async (silentParam?: boolean | unknown) => {
        const silent = silentParam === true;
        if (!store) return;
        setIsSyncing(true);
        try {
            const foundFolders = await invoke<TelegramFolder[]>('cmd_scan_folders');
            const merged = [...folders];
            let added = 0;
            for (const f of foundFolders) {
                if (!merged.find(existing => existing.id === f.id)) {
                    merged.push(f);
                    added++;
                }
            }
            if (added > 0) {
                setFolders(merged);
                await store.set('folders', merged);
                await store.save();
                if (!silent) {
                    toast.success(`Scan complete. Found ${added} new folders.`);
                }
            } else {
                if (!silent) {
                    toast.info("Scan complete. No new folders found.");
                }
            }
        } catch {
            if (!silent) {
                toast.error("Sync failed");
            }
        } finally {
            setIsSyncing(false);
        }
    };

    // Keep the ref in sync with the latest function on every render
    handleSyncFoldersRef.current = handleSyncFolders;

    const handleCreateFolder = async (name: string) => {
        if (!store) return;
        try {
            const newFolder = await invoke<TelegramFolder>('cmd_create_folder', { name });
            const updated = [...folders, newFolder];
            setFolders(updated);
            await store.set('folders', updated);
            await store.save();
            toast.success(`Folder "${name}" created.`);
        } catch (e) {
            toast.error("Failed to create folder: " + e);
            throw e;
        }
    };

    const handleFolderDelete = async (folderId: number, folderName: string) => {
        if (!await confirm({
            title: "Delete Folder",
            message: `Are you sure you want to delete "${folderName}"?\nThis will delete the channel on Telegram.`,
            confirmText: "Delete",
            variant: 'danger'
        })) return;

        try {
            await invoke('cmd_delete_folder', { folderId });
            const updated = folders.filter(f => f.id !== folderId);
            setFolders(updated);
            if (store) {
                await store.set('folders', updated);
                await store.save();
            }
            if (activeFolderId === folderId) setActiveFolderId(null);
            toast.success(`Folder "${folderName}" deleted.`);
        } catch (e: unknown) {
            const errStr = String(e);
            if (errStr.includes("not found")) {
                if (await confirm({
                    title: "Folder Not Found",
                    message: `Folder "${folderName}" not found on Telegram (it may have been deleted externally).\nRemove from this app?`,
                    confirmText: "Remove",
                    variant: 'info'
                })) {
                    const updated = folders.filter(f => f.id !== folderId);
                    setFolders(updated);
                    if (store) {
                        await store.set('folders', updated);
                        await store.save();
                    }
                    if (activeFolderId === folderId) setActiveFolderId(null);
                }
            } else {
                toast.error(`Failed to delete folder: ${e}`);
            }
        }
    };


    const handleFolderRename = async (folderId: number, oldName: string, newNameOverride?: string) => {
        const newName = newNameOverride?.trim();
        if (!newName || newName === oldName) return;

        try {
            await invoke('cmd_rename_folder', { folderId, newName });
            const updated = folders.map(f => f.id === folderId ? { ...f, name: newName } : f);
            setFolders(updated);
            if (store) {
                await store.set('folders', updated);
                await store.save();
            }
            toast.success(`Folder renamed to "${newName}".`);
        } catch (e) {
            toast.error("Failed to rename folder: " + e);
        }
    };

    const handleFolderToggleVisibility = async (folderId: number, makePublic: boolean, desiredUsername?: string) => {
        if (!makePublic) {
            const confirmed = await confirm({
                title: "Make Private",
                message: "Making this channel private will remove its public username. Any shared t.me links will stop working immediately.",
                confirmText: "Make Private",
                variant: 'danger'
            });
            if (!confirmed) return;
        }
        try {
            const updated = await invoke<TelegramFolder>('cmd_toggle_folder_visibility', {
                folderId,
                makePublic,
                desiredUsername: desiredUsername || null,
            });
            const newFolders = folders.map(f =>
                f.id === folderId ? { ...f, username: updated.username, is_public: updated.is_public } : f
            );
            setFolders(newFolders);
            if (store) {
                await store.set('folders', newFolders);
                await store.save();
            }
            toast.success(makePublic ? 'Channel is now public' : 'Channel is now private');
            return updated;
        } catch (e) {
            toast.error(`Failed to toggle visibility: ${e}`);
            throw e;
        }
    };

    const handleExportFolderInvite = async (folderId: number): Promise<FolderInviteInfo> => {
        try {
            const info = await invoke<FolderInviteInfo>('cmd_export_folder_invite', {
                folderId,
            });
            return info;
        } catch (e) {
            toast.error(`Failed to get invite link: ${e}`);
            throw e;
        }
    };

    const handleSetActiveFolderId = async (id: number | null) => {
        setActiveFolderId(id);
        if (store) {
            await store.set('activeFolderId', id);
            await store.save();
        }
    };

    return {
        store,
        folders,
        activeFolderId,
        setActiveFolderId: handleSetActiveFolderId,
        isSyncing,
        isConnected,
        handleLogout,
        handleSyncFolders,
        handleCreateFolder,
        handleFolderDelete,
        handleFolderRename,
        handleFolderToggleVisibility,
        handleExportFolderInvite,
    };
}
