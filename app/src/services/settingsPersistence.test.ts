import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config/defaultSettings';
import { readPersistedSettings, writePersistedSettings } from './settingsPersistence';

describe('settings persistence failures', () => {
  it('reports a read failure while retaining safe defaults', async () => {
    let observed = false;
    const settings = await readPersistedSettings(
      DEFAULT_SETTINGS,
      async () => { throw new Error('unavailable'); },
      () => { observed = true; },
    );
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(observed).toBe(true);
  });

  it('rejects writes so the UI can show and retry the failure', async () => {
    await expect(writePersistedSettings(
      DEFAULT_SETTINGS,
      async () => { throw new Error('unavailable'); },
    )).rejects.toThrow('unavailable');
  });
});
