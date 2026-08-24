import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
}

describe('target-specific Tauri capabilities', () => {
  it('keeps Android-only permissions restricted to Android builds', () => {
    const config = readJson('src-tauri/tauri.conf.json') as {
      app: { security: { capabilities: string[] } };
    };
    const mobile = readJson('src-tauri/capabilities/mobile.json') as {
      identifier: string;
      platforms?: string[];
    };
    const desktop = readJson('src-tauri/capabilities/default.json') as {
      platforms?: string[];
      permissions?: string[];
    };

    expect(config.app.security.capabilities).toContain('mobile-only');
    expect(mobile.identifier).toBe('mobile-only');
    expect(mobile.platforms).toEqual(['android']);
    expect(desktop.platforms).toEqual(['linux', 'macOS', 'windows']);
    expect(desktop.permissions).toContain('updater:default');
  });
});
