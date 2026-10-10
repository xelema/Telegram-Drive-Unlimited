import { invoke } from '@tauri-apps/api/core';

/** Preferred loopback port. The backend falls back to another one when it is taken. */
export const DEFAULT_LOCAL_MEDIA_PORT = 14201;
export const DEFAULT_LOCAL_MEDIA_ORIGIN = `http://localhost:${DEFAULT_LOCAL_MEDIA_PORT}`;

interface StartupHealth {
  streaming_port?: unknown;
}

let pendingOrigin: Promise<string> | null = null;

function originForPort(port: unknown): string {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535
    ? `http://localhost:${port}`
    : DEFAULT_LOCAL_MEDIA_ORIGIN;
}

/**
 * Origin of the loopback server that hosts streams and share pages. It is read from the backend once so that an origin check
 * keeps working when the preferred port was unavailable at startup.
 */
export function localMediaOrigin(): Promise<string> {
  pendingOrigin ??= invoke<StartupHealth | null>('cmd_get_startup_health')
    .then(health => originForPort(health?.streaming_port))
    .catch(() => {
      // Retry on the next request instead of caching a transient failure.
      pendingOrigin = null;
      return DEFAULT_LOCAL_MEDIA_ORIGIN;
    });
  return pendingOrigin;
}
