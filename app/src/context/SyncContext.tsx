import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addSyncPair, removeSyncPair, resolveSyncConflict, toggleSync } from '../services/syncService';
import { syncQueryKeys, useSyncEngine } from '../hooks/useSyncEngine';
import type { ConflictResolution } from '../types/sync';

type SyncContextValue = ReturnType<typeof useSyncEngine> & {
  setEnabled: (enabled: boolean) => Promise<void>;
  addPair: (localPath: string, channelId: number, label?: string) => Promise<void>;
  removePair: (pairId: number) => Promise<void>;
  resolveConflict: (pairId: number, path: string, resolution: ConflictResolution) => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const engine = useSyncEngine();
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.settings }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.pairs }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.status }),
      queryClient.invalidateQueries({ queryKey: syncQueryKeys.conflicts }),
    ]);
  }, [queryClient]);

  const setEnabled = useCallback(async (enabled: boolean) => { await toggleSync(enabled); await refresh(); }, [refresh]);
  const addPair = useCallback(async (localPath: string, channelId: number, label?: string) => { await addSyncPair(localPath, channelId, label); await refresh(); }, [refresh]);
  const removePair = useCallback(async (pairId: number) => { await removeSyncPair(pairId); await refresh(); }, [refresh]);
  const resolveConflict = useCallback(async (pairId: number, path: string, resolution: ConflictResolution) => { await resolveSyncConflict(pairId, path, resolution); await refresh(); }, [refresh]);

  return <SyncContext.Provider value={{ ...engine, setEnabled, addPair, removePair, resolveConflict }}>{children}</SyncContext.Provider>;
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used inside SyncProvider');
  return context;
}
