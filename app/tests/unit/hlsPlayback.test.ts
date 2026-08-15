import { describe, expect, it } from 'vitest';
import { buildAuthenticatedHlsUrl } from '../../src/services/hlsPlayback';

describe('HLS playback URL construction', () => {
  it('carries the current local stream token to the playlist URL', () => {
    expect(buildAuthenticatedHlsUrl(
      'http://localhost:14201/stream/home/42?token=session-token',
      '/hls/0_42/480p/index.m3u8',
    )).toBe('http://localhost:14201/hls/0_42/480p/index.m3u8?token=session-token');
  });

  it('rejects a playlist URL when the local stream token is unavailable', () => {
    expect(() => buildAuthenticatedHlsUrl(
      'http://localhost:14201/stream/home/42',
      '/hls/0_42/480p/index.m3u8',
    )).toThrow('The local stream token is unavailable');
  });
});
