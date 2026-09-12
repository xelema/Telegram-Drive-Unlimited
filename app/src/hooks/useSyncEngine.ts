import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSyncConflicts, getSyncPairs, getSyncSettings, getSyncStatus } from '../services/syncService';
import { getCurrentAccountId } from '../services/currentAccount';

export const syncQueryKeys = {
  settings: ['folder-sync', 'settings'] as const,
  pairs: ['folder-sync', 'pairs'] as const,
  status: ['folder-sync', 'status'] as const,
  conflicts: ['folder-sync', 'conflicts'] as const,
};

export function useSyncEngine() {
  const queryClient = useQueryClient();
  const [accountGeneration, setAccountGeneration] = useState(0);
  const account = useQuery({ queryKey: ['folder-sync', 'account', accountGeneration], queryFn: getCurrentAccountId, retry: false, refetchInterval: 5_000 });
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    // Logout clears the cache while this application-wide provider remains mounted.
    // Replace its observer immediately so removed A data cannot survive into B's UI.
    const key = event.query.queryKey;
    if (event.type === 'removed' && key[0] === 'folder-sync' && key[1] === 'account' && key[2] === accountGeneration) {
      setAccountGeneration(generation => generation + 1);
    }
  }), [accountGeneration, queryClient]);
  const ownerId = account.isError ? null : account.data ?? null;
  const settings = useQuery({ queryKey: [...syncQueryKeys.settings, ownerId], queryFn: () => getSyncSettings(ownerId!), enabled: !!ownerId });
  const pairs = useQuery({ queryKey: [...syncQueryKeys.pairs, ownerId], queryFn: () => getSyncPairs(ownerId!), enabled: !!ownerId });
  const status = useQuery({ queryKey: [...syncQueryKeys.status, ownerId], queryFn: () => getSyncStatus(ownerId!), enabled: !!ownerId, refetchInterval: 5_000 });
  const conflicts = useQuery({
    queryKey: [...syncQueryKeys.conflicts, ownerId],
    queryFn: () => getSyncConflicts(ownerId!),
    enabled: !!ownerId && (status.data?.conflicts ?? 0) > 0,
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('sync-status-changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['folder-sync', 'account'] });
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

  return { ownerId, settings, pairs, status, conflicts };
}
