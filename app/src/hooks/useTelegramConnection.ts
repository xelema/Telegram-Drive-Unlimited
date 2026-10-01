import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFolder, FolderInviteInfo, FolderGroup } from '../types';
import { useNetworkStatus } from './useNetworkStatus';
import { clearImageMemoryCaches } from '../services/imagePreviewCache';
import { userFacingError } from '../services/userFacingError';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { getCurrentAccountId } from '../services/currentAccount';

export function useTelegramConnection(onLogoutParent: () => void) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();
    const { t } = useTranslation();

    const [folders, setFolders] = useState<TelegramFolder[]>([]);
    const [groups, setGroups] = useState<FolderGroup[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
    const [store, setStore] = useState<Store | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    const [accountId, setAccountId] = useState<string | null>(null);
    const accountGeneration = useRef(0);
    const logoutInProgress = useRef(false);
    const accountRetryTimer = useRef<number | undefined>(undefined);
    const refreshAccountId = useCallback(async () => {
        if (logoutInProgress.current) return null;
        window.clearTimeout(accountRetryTimer.current);
        const generation = ++accountGeneration.current;
        const read = async (attempt: number): Promise<string | null> => {
            if (generation !== accountGeneration.current) return null;
            try {
                const id = await getCurrentAccountId();
                if (generation !== accountGeneration.current) return null;
                setAccountId(id);
                return id;
            } catch (error) {
                if (generation !== accountGeneration.current) return null;
                setAccountId(null);
                // A busy session database must not disable every file query
                // until a window visibility change. Never infer an owner or
                // retry an explicit signed-out/account-change response.
                if (attempt < 2 && !/ACCOUNT_(?:REQUIRED|CHANGED)/.test(String(error))) {
                    accountRetryTimer.current = window.setTimeout(() => { void read(attempt + 1); }, 1000 * (attempt + 1));
                }
                return null;
            }
        };
        return read(0);
    }, []);
    useEffect(() => {
        const refresh = () => { void refreshAccountId(); };
        refresh();
        document.addEventListener('visibilitychange', refresh);
        return () => {
            accountGeneration.current++;
            window.clearTimeout(accountRetryTimer.current);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [refreshAccountId]);

    const networkIsOnline = useNetworkStatus();
    const handleSyncFoldersRef = useRef<((silentParam?: boolean | unknown) => Promise<void>) | null>(null);
    const initialSyncStartedRef = useRef(false);
    const syncInFlightRef = useRef<Promise<void> | null>(null);

    // Fetch groups list from DB
    const fetchGroups = useCallback(async () => {
        try {
            const list = await invoke<FolderGroup[]>('cmd_get_groups');
            setGroups(list);
        } catch (e) {
            console.error("Failed to fetch folder groups:", e);
        }
    }, []);

    // Load persisted store and restore saved folders.
    useEffect(() => {
        const initStore = async () => {
            try {
                let _store = await load('config.json');
                let restoredFolderInventory = false;
                const checkId = await _store.get<string>('api_id');
                if (!checkId) {
                    _store = await load('settings.json');
                }
                // Fetch local-first SQLite enriched folders
                try {
                    const dbFolders = await invoke<TelegramFolder[]>('cmd_get_enriched_folders');
                    if (dbFolders && dbFolders.length > 0) {
                        setFolders(dbFolders);
                        restoredFolderInventory = true;
                    } else {
                        const savedFolders = await _store.get<TelegramFolder[]>('folders');
                        if (savedFolders) {
                            setFolders(savedFolders);
                            restoredFolderInventory = savedFolders.length > 0;
                        }
                    }
                } catch {
                    const savedFolders = await _store.get<TelegramFolder[]>('folders');
                    if (savedFolders) {
                        setFolders(savedFolders);
                        restoredFolderInventory = savedFolders.length > 0;
                    }
                }

                // Existing installations already have a verified local folder
                // inventory. Seed the new TTL marker so an upgrade does not
                // immediately repeat an account-wide discovery scan.
                if (restoredFolderInventory
                    && await _store.get<number>('foldersLastSyncedAt') == null) {
                    await _store.set('foldersLastSyncedAt', Date.now());
                    await _store.save();
                }

                // Fetch local-first SQLite groups
                try {
                    const list = await invoke<FolderGroup[]>('cmd_get_groups');
                    setGroups(list);
                } catch (e) {
                    console.error("Failed to load groups:", e);
                }

                const savedActiveFolderId = await _store.get<number | null>('activeFolderId');
                if (savedActiveFolderId !== undefined) setActiveFolderId(savedActiveFolderId);

                // Enable file queries only after the persisted folder has been restored.
                // Otherwise the dashboard briefly loads Saved Messages first, then starts
                // a second overlapping request for the actual startup folder.
                setStore(_store);
                setIsConnected(true);
            } catch {
                // store not available
            }
        };
        initStore();
    }, []);

    // Consolidated mount-sync + visibility-change listener
    useEffect(() => {
        if (!store || !isConnected) return;

        const syncAndRefresh = async () => {
            if (!handleSyncFoldersRef.current) return Promise.resolve();
            if (syncInFlightRef.current) return syncInFlightRef.current;

            const request = (async () => {
                const lastSyncAt = await store.get<number>('foldersLastSyncedAt');
                const folderSyncIsFresh = typeof lastSyncAt === 'number'
                    && Date.now() - lastSyncAt < 6 * 60 * 60_000;
                if (folderSyncIsFresh) return;
                await handleSyncFoldersRef.current?.(true);
            })().finally(() => {
                syncInFlightRef.current = null;
            });
            syncInFlightRef.current = request;
            return request;
        };

        // React Strict Mode remounts effects in development. Keep the initial refresh
        // single-shot so it cannot start two Telegram file streams for the same folder.
        if (!initialSyncStartedRef.current) {
            initialSyncStartedRef.current = true;
            void syncAndRefresh();
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void syncAndRefresh();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [store, isConnected]);

    useEffect(() => {
        setIsConnected(networkIsOnline);
    }, [networkIsOnline]);

    const handleLogout = async () => {
        if (logoutInProgress.current) return;
        logoutInProgress.current = true;
        let progress: string | number | undefined;
        let signedOut = false;
        try {
            if (!await confirm({ title: "Sign Out", message: "Are you sure you want to sign out? This will disconnect your active session.", confirmText: "Sign Out", variant: 'danger' })) return;
            progress = toast.loading(t('common.logout'), { description: t('common.loading') });
            // Ignore an account lookup that was already running when sign-out
            // began, but retain the current identity unless native logout succeeds.
            accountGeneration.current++;
            window.clearTimeout(accountRetryTimer.current);
            if (await invoke<boolean>('cmd_logout') !== true) throw new Error('Logout did not complete');
            signedOut = true;
            accountGeneration.current++;
            setAccountId(null);
            queryClient.clear();
            clearImageMemoryCaches();
            // Legacy installs can read either store. Remove only the Telegram
            // sign-in fields, never unrelated settings or supporter credentials.
            const cleanup = await Promise.allSettled([
                invoke('cmd_clean_cache'),
                invoke('cmd_clear_api_hash'),
                ...['config.json', 'settings.json'].map(async path => {
                    const target = await load(path);
                    const removals = await Promise.allSettled(['api_id', 'api_hash', 'folders'].map(key => target.delete(key)));
                    await target.save();
                    if (removals.some(result => result.status === 'rejected')) throw new Error('Sign-in field cleanup failed');
                }),
            ]);
            if (cleanup.some(result => result.status === 'rejected')) {
                toast.warning('Signed out, but some local cleanup could not finish.');
            }
        } catch (error) {
            if (signedOut) toast.warning('Signed out, but some local cleanup could not finish.');
            else toast.error(userFacingError(error, t));
        } finally {
            if (progress !== undefined) toast.dismiss(progress);
            logoutInProgress.current = false;
            if (signedOut) onLogoutParent();
        }
    };

    const handleSyncFolders = async (silentParam?: boolean | unknown) => {
        const silent = silentParam === true;
        if (!store) return;
        setIsSyncing(true);
        try {
            await refreshAccountId();
            const foundFolders = await invoke<TelegramFolder[]>('cmd_scan_folders');
            setFolders(foundFolders);
            await store.set('folders', foundFolders);
            await store.set('foldersLastSyncedAt', Date.now());
            await store.save();
            await fetchGroups();
            if (!silent) {
                toast.success("Folders and groups synchronized.");
            }
        } catch (e) {
            if (!silent) {
                toast.error(userFacingError(e, t));
            }
        } finally {
            setIsSyncing(false);
        }
    };

    // Keep the ref in sync
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
            toast.error(userFacingError(e, t));
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
            toast.error(userFacingError(e, t));
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

    // Group Management Actions
    const handleCreateGroup = async (name: string, colorHex: string = '#3B82F6') => {
        try {
            const id = await invoke<number>('cmd_create_group', { name, colorHex });
            const newGroup: FolderGroup = { id, name, color_hex: colorHex, display_order: groups.length };
            setGroups(prev => [...prev, newGroup]);
            toast.success(`Group "${name}" created.`);
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleDeleteGroup = async (groupId: number) => {
        try {
            await invoke('cmd_delete_group', { groupId });
            setGroups(prev => prev.filter(g => g.id !== groupId));
            setFolders(prev => prev.map(f => f.group_id === groupId ? { ...f, group_id: null } : f));
            toast.success("Group deleted.");
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleUpdateGroup = async (groupId: number, name: string, colorHex: string) => {
        try {
            await invoke('cmd_update_group', { groupId, name, colorHex });
            setGroups(prev => prev.map(g => g.id === groupId ? { ...g, name, color_hex: colorHex } : g));
            toast.success("Group updated.");
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleAssignFolderToGroup = async (folderId: number, groupId: number | null) => {
        try {
            await invoke('cmd_assign_folder_to_group', { channelId: folderId, groupId });
            setFolders(prev => prev.map(f => f.id === folderId ? { ...f, group_id: groupId } : f));
        } catch (e) {
            toast.error(userFacingError(e, t));
        }
    };

    const handleReorderFolders = async (reordered: TelegramFolder[]) => {
        setFolders(reordered);
        if (store) {
            await store.set('folders', reordered);
            await store.save();
        }
        try {
            await Promise.all(
                reordered.map((folder, index) =>
                    invoke('cmd_update_folder_order', { channelId: folder.id, newOrder: index })
                )
            );
        } catch (e) {
            console.error("Failed to persist folder reordering:", e);
        }
    };

    const handleUpdateGroupOrder = async (reorderedGroups: FolderGroup[]) => {
        setGroups(reorderedGroups);
        try {
            await Promise.all(
                reorderedGroups.map((g, index) =>
                    invoke('cmd_update_group_order', { groupId: g.id, newOrder: index })
                )
            );
        } catch (e) {
            console.error("Failed to persist group order:", e);
        }
    };

    return {
        store,
        accountId,
        folders,
        groups,
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
        // Group Actions
        handleCreateGroup,
        handleDeleteGroup,
        handleUpdateGroup,
        handleAssignFolderToGroup,
        handleReorderFolders,
        handleUpdateGroupOrder,
        fetchGroups
    };
}
