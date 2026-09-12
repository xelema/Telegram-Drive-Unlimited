import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncProvider, useSync } from '../../src/context/SyncContext';
import type { SyncPair } from '../../src/types/sync';

const native = vi.hoisted(() => ({ invoke: vi.fn(), owner: '100' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

let latest: ReturnType<typeof useSync>;
function Harness() {
  latest = useSync();
  return <><p>{latest.ownerId}</p>{latest.pairs.data?.map(pair => <p key={pair.id}>{pair.label}</p>)}</>;
}
const pair = (owner: string): SyncPair => ({
  id: Number(owner), localPath: `/synthetic/${owner}`, channelId: 7, folderKey: '7', label: `Owner ${owner} mapping`,
  syncDirection: 'upload_only', isActive: false, createdAt: 0, accountOwner: owner,
  preferences: { ignorePatterns: [], propagateDeletions: false, pauseOnConflicts: true },
});
function renderSync() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SyncProvider><Harness /></SyncProvider></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => {
  native.owner = '100'; native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args?: { ownerId?: string }) => {
    if (command === 'cmd_workspace_account') {
      if (native.owner === 'none') throw new Error('ACCOUNT_REQUIRED');
      return native.owner;
    }
    if (args?.ownerId !== native.owner) throw new Error('ACCOUNT_CHANGED');
    if (command === 'cmd_get_sync_settings') return { enabled: false };
    if (command === 'cmd_get_sync_pairs') return [pair(native.owner)];
    if (command === 'cmd_get_sync_status') return { pairs: [], conflicts: 0 };
    if (command === 'cmd_get_sync_conflicts') return [];
    if (command === 'cmd_remove_sync_pair') return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe('sync account boundaries', () => {
  it('drops mounted provider data when logout clears the query cache', async () => {
    const view = renderSync();
    await screen.findByText('Owner 100 mapping');
    native.owner = 'none';
    await act(async () => { view.client.clear(); });
    await waitFor(() => expect(latest.ownerId).toBeNull());
    expect(screen.queryByText('Owner 100 mapping')).toBeNull();
    native.owner = '200';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['folder-sync', 'account'] }); });
    await screen.findByText('Owner 200 mapping');
    expect(screen.queryByText('Owner 100 mapping')).toBeNull();
    view.unmount(); view.client.clear();
  });
  it('keeps a deferred old-account action bound to its original owner', async () => {
    const view = renderSync();
    await screen.findByText('Owner 100 mapping');
    const oldRemove = latest.removePair;
    native.owner = '200';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['folder-sync', 'account'] }); });
    await screen.findByText('Owner 200 mapping');
    await expect(oldRemove(100)).rejects.toThrow('ACCOUNT_CHANGED');
    expect(native.invoke).toHaveBeenLastCalledWith('cmd_remove_sync_pair', { pairId: 100, ownerId: '100' });
    expect(screen.queryByText('Owner 100 mapping')).toBeNull();
    view.unmount(); view.client.clear();
  });

  it('keeps a late old-account list out of the current account cache', async () => {
    let finish!: (pairs: SyncPair[]) => void;
    const implementation = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((command: string, args?: { ownerId?: string }) => {
      if (command === 'cmd_get_sync_pairs' && args?.ownerId === '100') return new Promise<SyncPair[]>(resolve => { finish = resolve; });
      return implementation(command, args);
    });
    const view = renderSync();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    native.owner = '200';
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['folder-sync', 'account'] }); });
    await screen.findByText('Owner 200 mapping');
    await act(async () => finish([pair('100')]));
    expect(screen.queryByText('Owner 100 mapping')).toBeNull();
    expect(screen.getByText('Owner 200 mapping')).toBeTruthy();
    expect(view.client.getQueryData(['folder-sync', 'pairs', '200'])).toEqual([pair('200')]);
    view.unmount(); view.client.clear();
  });
});
