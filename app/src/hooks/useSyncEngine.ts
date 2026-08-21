import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSyncConflicts, getSyncPairs, getSyncSettings, getSyncStatus } from '../services/syncService';

export const syncQueryKeys = {
  settings: ['folder-sync', 'settings'] as const,
  pairs: ['folder-sync', 'pairs'] as const,
  status: ['folder-sync', 'status'] as const,
  conflicts: ['folder-sync', 'conflicts'] as const,
};

export function useSyncEngine() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: syncQueryKeys.settings, queryFn: getSyncSettings });
  const pairs = useQuery({ queryKey: syncQueryKeys.pairs, queryFn: getSyncPairs });
  const status = useQuery({ queryKey: syncQueryKeys.status, queryFn: getSyncStatus, refetchInterval: 5_000 });
  const conflicts = useQuery({
    queryKey: syncQueryKeys.conflicts,
    queryFn: getSyncConflicts,
    enabled: (status.data?.conflicts ?? 0) > 0,
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('sync-status-changed', () => {
      void queryClient.invalidateQueries({ queryKey: syncQueryKeys.status });
      void queryClient.invalidateQueries({ queryKey: syncQueryKeys.conflicts });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  return { settings, pairs, status, conflicts };
}
