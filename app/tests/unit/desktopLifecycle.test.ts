import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  DEFAULT_DESKTOP_PREFERENCES,
  getDesktopPreferences,
  normalizeDesktopPreferences,
  updateDesktopPreferences,
} from '../../src/services/desktopLifecycle';

describe('desktop lifecycle preferences', () => {
  beforeEach(() => invoke.mockReset());

  it('defaults to recoverable background behavior and private notifications', () => {
    expect(DEFAULT_DESKTOP_PREFERENCES).toMatchObject({
      backgroundModeEnabled: true,
      closeBehavior: 'background',
      notificationsEnabled: false,
      notifyWhileVisible: false,
      showFilenamesInNotifications: false,
    });
  });

  it('normalizes missing and unsupported persisted values', () => {
    expect(normalizeDesktopPreferences({ notificationsEnabled: true })).toMatchObject({
      schemaVersion: 1,
      closeBehavior: 'background',
      notificationsEnabled: true,
      showFilenamesInNotifications: false,
    });
    expect(normalizeDesktopPreferences({ closeBehavior: 'invalid' as never }).closeBehavior)
      .toBe('background');
  });

  it('uses the typed backend preference contract', async () => {
    invoke.mockResolvedValueOnce({ backgroundModeEnabled: false, closeBehavior: 'quit' });
    await expect(getDesktopPreferences()).resolves.toMatchObject({
      backgroundModeEnabled: false,
      closeBehavior: 'quit',
    });

    invoke.mockResolvedValueOnce(DEFAULT_DESKTOP_PREFERENCES);
    await updateDesktopPreferences(DEFAULT_DESKTOP_PREFERENCES);
    expect(invoke).toHaveBeenLastCalledWith('cmd_update_desktop_preferences', {
      preferences: DEFAULT_DESKTOP_PREFERENCES,
    });
  });
});
