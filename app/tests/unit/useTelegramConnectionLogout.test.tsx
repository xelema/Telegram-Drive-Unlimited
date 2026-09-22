import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/i18n';
import { ConfirmProvider } from '../../src/context/ConfirmContext';
import { useTelegramConnection } from '../../src/hooks/useTelegramConnection';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), load: vi.fn(), clearImages: vi.fn(),
  loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), warning: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-store', () => ({ load: mocks.load }));
vi.mock('../../src/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }));
vi.mock('../../src/services/imagePreviewCache', () => ({ clearImageMemoryCaches: mocks.clearImages }));
vi.mock('../../src/services/feedback', () => ({ triggerHaptic: vi.fn() }));
vi.mock('sonner', () => ({ toast: {
  loading: mocks.loading, dismiss: mocks.dismiss, error: mocks.error,
  warning: mocks.warning, success: vi.fn(),
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeStore() {
  const values: Record<string, unknown> = {
    api_id: '12345', api_hash: 'legacy-api-hash', folders: [],
    foldersLastSyncedAt: Date.now(), activeFolderId: null,
    supporter_activation: 'must-preserve', theme: 'must-preserve',
  };
  return {
    get: vi.fn(async (key: string) => values[key]),
    set: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    delete: vi.fn(async (key: string) => { delete values[key]; }),
    save: vi.fn(async () => undefined),
    values,
  };
}

let config: ReturnType<typeof makeStore>;
let legacy: ReturnType<typeof makeStore>;

beforeEach(() => {
  vi.clearAllMocks();
  config = makeStore();
  legacy = makeStore();
  mocks.load.mockImplementation(async path => path === 'config.json' ? config : legacy);
  mocks.loading.mockReturnValue('logout-progress');
  mocks.invoke.mockImplementation(async command => {
    if (command === 'cmd_workspace_account') return 'account-A';
    if (command === 'cmd_get_enriched_folders' || command === 'cmd_get_groups') return [];
    if (command === 'cmd_logout') return true;
    return undefined;
  });
});

async function setup() {
  const onLogout = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['private', 'account-A'], 'retained-until-native-success');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}><ConfirmProvider>{children}</ConfirmProvider></QueryClientProvider>
  );
  const hook = renderHook(() => useTelegramConnection(onLogout), { wrapper });
  await waitFor(() => expect(hook.result.current.store).toBe(config));
  await waitFor(() => expect(hook.result.current.accountId).toBe('account-A'));
  return { ...hook, client, onLogout };
}

async function confirmLogout(handle: () => Promise<void>) {
  let pending!: Promise<void>;
  act(() => { pending = handle(); });
  const dialog = await screen.findByRole('dialog', { name: 'Sign Out' });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Sign Out' })); });
  return { pending };
}

const cleanupCommands = () => mocks.invoke.mock.calls
  .map(([command]) => command)
  .filter(command => command === 'cmd_clean_cache' || command === 'cmd_clear_api_hash');

describe('confirmed Telegram sign-out', () => {
  it('cancels without touching the native session, caches, or credentials', async () => {
    const { result, client, onLogout } = await setup();
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleLogout(); });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await act(async () => { await pending; });
    expect(mocks.invoke).not.toHaveBeenCalledWith('cmd_logout');
    expect(mocks.loading).not.toHaveBeenCalled();
    expect(config.delete).not.toHaveBeenCalled();
    expect(client.getQueryData(['private', 'account-A'])).toBe('retained-until-native-success');
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('shows progress and prevents repeated confirmations or native calls while logout is pending', async () => {
    const native = deferred<boolean>();
    const { result, client, onLogout } = await setup();
    mocks.invoke.mockImplementation(command => command === 'cmd_logout' ? native.promise : Promise.resolve(undefined));
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleLogout(); });
    await result.current.handleLogout();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign Out' }));
    await waitFor(() => expect(mocks.loading).toHaveBeenCalledWith('Log Out', { description: 'Loading...' }));
    await result.current.handleLogout();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cmd_logout')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onLogout).not.toHaveBeenCalled();
    expect(result.current.accountId).toBe('account-A');
    expect(client.getQueryData(['private', 'account-A'])).toBe('retained-until-native-success');
    expect(cleanupCommands()).toEqual([]);
    expect(config.delete).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    await act(async () => { native.resolve(true); await pending; });
    expect(onLogout).toHaveBeenCalledOnce();
    expect(mocks.dismiss).toHaveBeenCalledWith('logout-progress');
  });

  it.each(['reject', 'false'])('retains the current session UI when native logout returns %s', async outcome => {
    const { result, client, onLogout } = await setup();
    mocks.invoke.mockImplementation(command => command === 'cmd_logout'
      ? outcome === 'reject' ? Promise.reject(new Error('native private diagnostic')) : Promise.resolve(false)
      : Promise.resolve(undefined));
    const { pending } = await confirmLogout(result.current.handleLogout);
    await act(async () => { await pending; });
    expect(onLogout).not.toHaveBeenCalled();
    expect(result.current.accountId).toBe('account-A');
    expect(client.getQueryData(['private', 'account-A'])).toBe('retained-until-native-success');
    expect(mocks.clearImages).not.toHaveBeenCalled();
    expect(cleanupCommands()).toEqual([]);
    expect(config.delete).not.toHaveBeenCalled();
    expect(legacy.delete).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.error.mock.calls.flat().join(' ')).not.toContain('native private diagnostic');
    expect(mocks.dismiss).toHaveBeenCalledWith('logout-progress');
    act(() => { void result.current.handleLogout(); });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('returns to sign-in after native success even when cache or credential cleanup fails', async () => {
    const { result, client, onLogout } = await setup();
    mocks.invoke.mockImplementation(command => command === 'cmd_logout' ? Promise.resolve(true) : Promise.reject(new Error('cleanup failed')));
    config.delete.mockImplementation(async key => { if (key === 'api_id') throw new Error('locked field'); });
    const { pending } = await confirmLogout(result.current.handleLogout);
    await act(async () => { await pending; });
    expect(onLogout).toHaveBeenCalledOnce();
    expect(result.current.accountId).toBeNull();
    expect(client.getQueryData(['private', 'account-A'])).toBeUndefined();
    expect(mocks.clearImages).toHaveBeenCalledOnce();
    expect(cleanupCommands()).toEqual(['cmd_clean_cache', 'cmd_clear_api_hash']);
    for (const target of [config, legacy]) {
      expect(target.delete.mock.calls.map(([key]) => key).sort()).toEqual(['api_hash', 'api_id', 'folders']);
      expect(target.save).toHaveBeenCalledOnce();
      expect(target.values.supporter_activation).toBe('must-preserve');
      expect(target.values.theme).toBe('must-preserve');
    }
    expect(mocks.warning).toHaveBeenCalledWith('Signed out, but some local cleanup could not finish.');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not re-adopt an old account lookup after native sign-out succeeds', async () => {
    const { result, onLogout } = await setup();
    const staleAccount = deferred<string>();
    mocks.invoke.mockImplementation(command => command === 'cmd_workspace_account' ? staleAccount.promise : Promise.resolve(command === 'cmd_logout' ? true : undefined));
    fireEvent(document, new Event('visibilitychange'));
    const { pending } = await confirmLogout(result.current.handleLogout);
    await act(async () => { await pending; staleAccount.resolve('account-A'); });
    expect(onLogout).toHaveBeenCalledOnce();
    expect(result.current.accountId).toBeNull();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
