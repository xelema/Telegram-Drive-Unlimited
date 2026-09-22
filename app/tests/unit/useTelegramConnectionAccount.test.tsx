import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { useTelegramConnection } from '../../src/hooks/useTelegramConnection';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), get: vi.fn(), set: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn(async () => ({ get: mocks.get, set: mocks.set, save: mocks.save })) }));
vi.mock('../../src/context/ConfirmContext', () => ({ useConfirm: () => ({ confirm: vi.fn() }) }));
vi.mock('../../src/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  const values: Record<string, unknown> = { api_id: '12345', foldersLastSyncedAt: Date.now(), activeFolderId: 42 };
  mocks.get.mockImplementation(async key => values[key]);
  mocks.set.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTelegramConnection(vi.fn()), { wrapper });
  await waitFor(() => expect(hook.result.current.store).not.toBeNull());
  return hook;
}

function provideAccount(read: () => Promise<string>) {
  mocks.invoke.mockImplementation(async command => {
    if (command === 'cmd_workspace_account') return read();
    if (command === 'cmd_get_enriched_folders' || command === 'cmd_get_groups') return [];
    return undefined;
  });
}

describe('desktop account lookup recovery', () => {
  it('retries the verified identity when a folder refresh follows a transient startup lookup failure', async () => {
    let accountReads = 0;
    const folders = [{ id: 42, name: 'Existing folder' }];
    mocks.invoke.mockImplementation(async command => {
      if (command === 'cmd_workspace_account') {
        if (++accountReads === 1) throw new Error('ACCOUNT_UNAVAILABLE');
        return 'account-A';
      }
      if (command === 'cmd_get_enriched_folders' || command === 'cmd_scan_folders') return folders;
      if (command === 'cmd_get_groups') return [];
      return undefined;
    });
    const { result } = await mount();
    expect(result.current.folders).toEqual(folders);
    expect(result.current.accountId).toBeNull();
    await act(async () => { await result.current.handleSyncFolders(); });
    expect(accountReads).toBeGreaterThan(1);
    expect(result.current.accountId).toBe('account-A');
  });

  it('recovers automatically from a transient initial database read failure', async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('account-A');
    provideAccount(read);
    const { result } = await mount();
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error('ACCOUNT_UNAVAILABLE')); });
    expect(result.current.accountId).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.accountId).toBe('account-A');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated transient lookup failures and waits for an explicit later retry', async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValue(new Error('ACCOUNT_UNAVAILABLE'));
    provideAccount(read);
    const { result } = await mount();
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error('ACCOUNT_UNAVAILABLE')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.accountId).toBeNull();
  });

  it('rejects late account A results after a newer verified lookup selects B', async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('account-B');
    provideAccount(read);
    const { result } = await mount();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current.accountId).toBe('account-B');
    await act(async () => { first.resolve('account-A'); });
    expect(result.current.accountId).toBe('account-B');
  });

  it('cancels a scheduled old-generation retry after a new verified lookup', async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('account-B');
    provideAccount(read);
    const { result } = await mount();
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error('ACCOUNT_UNAVAILABLE')); });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.accountId).toBe('account-B');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the dashboard unmounts', async () => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('account-A');
    provideAccount(read);
    const { unmount } = await mount();
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error('ACCOUNT_UNAVAILABLE')); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(['ACCOUNT_REQUIRED', 'ACCOUNT_CHANGED'])('does not retry the terminal %s response', async code => {
    const first = deferred<string>();
    const read = vi.fn().mockReturnValue(first.promise);
    provideAccount(read);
    const { result } = await mount();
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error(code)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.accountId).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
});
