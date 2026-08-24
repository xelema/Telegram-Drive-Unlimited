import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultActivity } from '../../src/hooks/useVaultActivity';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

describe('useVaultActivity', () => {
  let now: number;

  beforeEach(() => {
    now = 0;
    invokeMock.mockReset().mockResolvedValue(undefined);
    setVisibility('visible');
    vi.spyOn(window.performance, 'now').mockImplementation(() => now);
  });

  it('throttles high-frequency input and stops after unmount', () => {
    const hook = renderHook(() => useVaultActivity(true));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_record_vault_activity');

    act(() => {
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('keydown'));
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    now = 5_000;
    act(() => window.dispatchEvent(new Event('pointermove')));
    expect(invokeMock).toHaveBeenCalledTimes(2);

    hook.unmount();
    now = 10_000;
    act(() => window.dispatchEvent(new Event('pointerdown')));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('ignores hidden input and records a visible resume', () => {
    renderHook(() => useVaultActivity(true));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    now = 5_000;
    act(() => window.dispatchEvent(new Event('pointerdown')));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('cmd_record_vault_activity');
  });

  it('does not report activity while the vault is locked', () => {
    const hook = renderHook(({ enabled }) => useVaultActivity(enabled), {
      initialProps: { enabled: false },
    });
    act(() => window.dispatchEvent(new Event('pointerdown')));
    expect(invokeMock).not.toHaveBeenCalled();

    hook.rerender({ enabled: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
