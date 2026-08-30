import { describe, expect, it } from 'vitest';
import { userFacingError } from './userFacingError';

const t = (key: string) => `translated:${key}`;

describe('userFacingError', () => {
  it('maps reviewed backend codes to localized copy', () => {
    expect(userFacingError('[ENCRYPTED_PREVIEW_UNAVAILABLE] internal detail', t))
      .toBe('translated:archive.failed_read');
  });

  it('never exposes unknown raw paths, tokens, or remote responses', () => {
    const raw = 'upload failed for /Users/person/private.txt?token=secret-value';
    const result = userFacingError(raw, t);
    expect(result).toBe('translated:common.operation_failed');
    expect(result).not.toContain('private.txt');
    expect(result).not.toContain('secret-value');
  });
});
