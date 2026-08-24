import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseVersion } = require('../../scripts/verify-android-release-version.cjs') as {
  parseVersion: (version: string) => { version: string; versionCode: number };
};

describe('Android release versioning', () => {
  it('maps semantic versions to monotonically ordered Android version codes', () => {
    expect(parseVersion('3.0.0').versionCode).toBe(3_000_000);
    expect(parseVersion('3.1.2').versionCode).toBe(3_001_002);
    expect(parseVersion('4.0.0').versionCode).toBeGreaterThan(parseVersion('3.999.999').versionCode);
  });

  it('rejects ambiguous or overflowing versions', () => {
    expect(() => parseVersion('3.0')).toThrow();
    expect(() => parseVersion('3.1000.0')).toThrow();
    expect(() => parseVersion('9999.0.0')).toThrow();
  });
});
