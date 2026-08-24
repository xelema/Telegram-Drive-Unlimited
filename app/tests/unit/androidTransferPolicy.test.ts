import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/defaultSettings';
import { evaluateAndroidTransferPolicy, type AndroidTransferEnvironment } from '../../src/services/androidTransferPolicy';

const ready: AndroidTransferEnvironment = {
  connected: true,
  metered: false,
  roaming: false,
  charging: true,
  batteryLow: false,
  storageLow: false,
  freeBytes: 20 * 1024 ** 3,
  powerSaveMode: false,
  backgroundRestricted: false,
  isTelevision: false,
};

describe('Android transfer policy', () => {
  it('allows a transfer when every selected constraint is satisfied', () => {
    expect(evaluateAndroidTransferPolicy(ready, DEFAULT_SETTINGS)).toEqual({ allowed: true });
  });

  it('waits for unmetered Wi-Fi when Wi-Fi-only mode is selected', () => {
    expect(evaluateAndroidTransferPolicy(
      { ...ready, metered: true },
      { ...DEFAULT_SETTINGS, androidWifiOnlyTransfers: true },
    ).reason).toContain('Wi-Fi');
  });

  it('blocks roaming and low-storage transfers by default', () => {
    expect(evaluateAndroidTransferPolicy({ ...ready, roaming: true }, DEFAULT_SETTINGS).allowed).toBe(false);
    expect(evaluateAndroidTransferPolicy({ ...ready, freeBytes: 100 }, DEFAULT_SETTINGS).allowed).toBe(false);
  });

  it('reserves enough room for a known download plus a safety margin', () => {
    expect(evaluateAndroidTransferPolicy(
      { ...ready, freeBytes: 3 * 1024 ** 3 },
      DEFAULT_SETTINGS,
      4 * 1024 ** 3,
    ).allowed).toBe(false);
  });
});
