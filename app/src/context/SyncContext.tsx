import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addSyncPair, removeSyncPair, resolveSyncConflict, setSyncPairActive, toggleSync, updateSyncPair } from '../services/syncService';
import { syncQueryKeys, useSyncEngine } from '../hooks/useSyncEngine';
import type { ConflictResolution, SyncPairSaveOptions, SyncPreviewRequest } from '../types/sync';

type SyncContextValue = ReturnType<typeof useSyncEngine> & {
  setEnabled: (enabled: boolean) => Promise<void>;
  addPair: (localPath: string, channelId: number, label: string | undefined, options: SyncPairSaveOptions) => Promise<void>;
  updatePair: (request: SyncPreviewRequest, previewToken: string, isActive: boolean) => Promise<void>;
  setPairActive: (pairId: number, isActive: boolean) => Promise<void>;
  removePair: (pairId: number) => Promise<void>;
  resolveConflict: (pairId: number, path: string, resolution: ConflictResolution) => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const engine = useSyncEngine();
  const ownerId = engine.ownerId;
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.settings }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.pairs }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.status }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.conflicts }),
    ]);
  }, [queryClient]);

  const setEnabled = useCallback(async (enabled: boolean) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await toggleSync(enabled, ownerId); await refresh(); }, [refresh, ownerId]);
  const addPair = useCallback(async (localPath: string, channelId: number, label: string | undefined, options: SyncPairSaveOptions) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await addSyncPair(localPath, channelId, label, options, ownerId); await refresh(); }, [refresh, ownerId]);
  const updatePair = useCallback(async (request: SyncPreviewRequest, previewToken: string, isActive: boolean) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await updateSyncPair(request, previewToken, isActive, ownerId); await refresh(); }, [refresh, ownerId]);
  const setPairActive = useCallback(async (pairId: number, isActive: boolean) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await setSyncPairActive(pairId, isActive, ownerId); await refresh(); }, [refresh, ownerId]);
  const removePair = useCallback(async (pairId: number) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await removeSyncPair(pairId, ownerId); await refresh(); }, [refresh, ownerId]);
  const resolveConflict = useCallback(async (pairId: number, path: string, resolution: ConflictResolution) => { if (!ownerId) throw new Error('ACCOUNT_REQUIRED'); await resolveSyncConflict(pairId, path, resolution, ownerId); await refresh(); }, [refresh, ownerId]);

  return <SyncContext.Provider value={{ ...engine, setEnabled, addPair, updatePair, setPairActive, removePair, resolveConflict }}>{children}</SyncContext.Provider>;
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used inside SyncProvider');
  return context;
}
