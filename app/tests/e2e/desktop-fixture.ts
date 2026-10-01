import type { Page } from '@playwright/test';

/** Real application entry point and providers; only the native/service boundary is simulated.
 * These browser journeys do not validate SQLite, Keychain, Telegram, or payment cryptography.
 */
export async function desktopFixture(page: Page, options: {
  accountFailures?: number;
  holdFiles?: boolean;
  holdSupporter?: boolean;
  supporterState?: 'active' | 'needs_refresh' | 'expired' | 'inactive';
  update?: boolean;
  packageManaged?: boolean;
  signedOut?: boolean;
  gatewaySeen?: boolean;
} = {}) {
  await page.route('http://localhost:14201/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>Offline sponsor fixture</p>' }));
  await page.addInitScript(options => {
    const stores = JSON.parse(localStorage.getItem('desktop-e2e-stores') || 'null') ?? {
      'config.json': { api_id: options.signedOut ? undefined : '12345', foldersLastSyncedAt: Date.now(), activeFolderId: 9, ad_gateway_passed: options.gatewaySeen ?? true },
      'settings.json': { settings: { crashReportingEnabled: false, crashReportingConsentSeen: true, driveTourSeen: true, language: 'en', viewMode: 'list' }, supporter_activation: 'preserve-existing-license' },
    };
    const persist = () => localStorage.setItem('desktop-e2e-stores', JSON.stringify(stores));
    const callbacks = new Map<number, (value: any) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    let releaseFiles: (() => void) | undefined;
    let releaseSupporter: (() => void) | undefined;
    const fileGate = new Promise<void>(resolve => { releaseFiles = resolve; });
    const supporterGate = new Promise<void>(resolve => { releaseSupporter = resolve; });
    const state = {
      owner: '101', accountFailures: options.accountFailures ?? 0, holdFiles: options.holdFiles ?? false,
      holdSupporter: options.holdSupporter ?? false, supporterState: options.supporterState ?? 'active',
      supporterRefreshFails: options.supporterState === 'needs_refresh',
      logoutFails: false, saveFails: false, installFails: true, incompleteDownload: false,
      update: options.update ?? false, stores, calls: [] as { command: string; args: any }[],
      completedFileRequests: [] as { ownerId: string; requestId: string }[],
      releaseFiles: () => { state.holdFiles = false; releaseFiles?.(); },
      releaseSupporter: () => { state.holdSupporter = false; releaseSupporter?.(); },
      emit: (event: string, payload: any) => {
        for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ id, event, payload });
      },
    };
    const file = (id: number, folder: number | null, owner = state.owner) => ({
      id, folder_id: folder, ownerId: owner, name: `${owner === '101' ? 'Holiday' : 'Work'} ${folder === null ? 'saved' : 'folder'} photo.jpg`,
      size: 1024, mime_type: 'image/jpeg', file_ext: 'jpg', created_at: '2026-09-07T12:00:00Z', folderName: folder === null ? 'Saved Messages' : 'Photos',
      encryption_state: 'plain', is_favorite: false, type: 'image',
    });
    const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#284b63"/><circle cx="320" cy="240" r="150" fill="#98d8ea"/></svg>')}`;
    const status = () => ({
      state: state.supporterState, ad_free: ['active', 'needs_refresh'].includes(state.supporterState),
      message: 'Fixture entitlement', terms_version: '2026-08-11', terms_url: 'https://example.invalid/terms',
      expires_at: Date.now() / 1000 + (state.supporterState === 'active' ? 86400 : -86400),
      offline_until: Date.now() / 1000 + 6 * 86400, recovery_code_saved: state.supporterState !== 'inactive', checkout_pending: false,
    });
    Object.assign(window, {
      __desktopTest: state,
      __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'windows', platform: 'windows', arch: 'x86_64', version: '11', family: 'windows' },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (value: any) => void) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (path: string) => path,
        invoke: async (command: string, args: any = {}) => {
          state.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = nextId++; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'plugin:store|load') { stores[args.path] ??= {}; return args.path; }
          const store = stores[args.rid];
          if (command === 'plugin:store|get') return [store?.[args.key], args.key in (store ?? {})];
          if (command === 'plugin:store|set') { store[args.key] = args.value; return; }
          if (command === 'plugin:store|delete') { delete store[args.key]; return true; }
          if (command === 'plugin:store|save') { if (state.saveFails) throw new Error('Storage unavailable'); persist(); return; }
          if (command === 'cmd_get_startup_health') return { ready: true };
          if (command === 'cmd_auth_qr_login') return 'tg://login?token=browser-fixture-only';
          if (command === 'cmd_auth_qr_poll') return { success: false };
          if (command === 'cmd_auth_request_code') return { status: 'code_required', delivery: 'telegram_app', codeLength: 5, numericCode: true };
          if (command === 'cmd_auth_sign_in') return { success: false, next_step: 'password' };
          if (command === 'cmd_auth_check_password') {
            if (args.password === 'incorrect-fixture-password') throw new Error('Password verification failed.');
            return { success: true };
          }
          if (command === 'cmd_check_connection' || command === 'cmd_is_network_available') return true;
          if (command === 'cmd_workspace_account') {
            if (state.accountFailures-- > 0) throw new Error('ACCOUNT_UNAVAILABLE: Session temporarily busy');
            return state.owner;
          }
          if (command === 'cmd_get_enriched_folders' || command === 'cmd_scan_folders') return [{ id: 9, name: 'Photos', file_count: 1 }];
          if (['cmd_get_groups', 'cmd_get_cached_files', 'cmd_get_sync_pairs', 'cmd_get_sync_jobs', 'cmd_list_shares', 'cmd_list_cached_files'].includes(command)) return [];
          if (command === 'cmd_get_file_activity') return [file(42, 9)];
          if (command === 'cmd_get_files') {
            const owner = args.ownerId;
            if (state.holdFiles && owner === '101') await fileGate;
            const result = { ownerId: owner, folderId: args.folderId, requestId: args.requestId, files: [file(42, args.folderId, owner)] };
            state.emit('folder-load-chunk', result);
            state.completedFileRequests.push({ ownerId: owner, requestId: args.requestId });
            return { ...result, complete: true };
          }
          if (command === 'cmd_get_preview' || command === 'cmd_workspace_asset') return image;
          if (command === 'cmd_get_bandwidth') return { uploaded: 0, downloaded: 0, upload_speed: 0, download_speed: 0 };
          if (command === 'cmd_get_supporter_status') { if (state.holdSupporter) await supporterGate; return status(); }
          if (command === 'cmd_refresh_supporter') { if (state.supporterRefreshFails) throw new Error('Network offline'); return status(); }
          if (command === 'cmd_begin_supporter_checkout') throw new Error('Checkout forbidden in browser fixtures');
          if (command === 'cmd_activate_supporter') { state.supporterState = 'active'; return status(); }
          if (command === 'cmd_logout') { if (state.logoutFails) throw new Error('Private native diagnostic'); return true; }
          if (command === 'cmd_get_encryption_capabilities') return { contract_version: 2, availability: 'ready', vault: true, per_file: true };
          if (command === 'cmd_get_vault_status') return { exists: false, is_unlocked: false };
          if (command === 'cmd_get_encryption_settings' || command === 'cmd_update_encryption_settings') return args.settings ?? { default_mode: 'none' };
          if (command === 'cmd_get_file_encryption_info') return { state: 'plain', protection_mode: 'none' };
          if (command === 'cmd_get_api_settings') return { enabled: false, running: false, port: 14201 };
          if (command === 'cmd_get_webdav_settings') return { enabled: false, running: false, port: 14202 };
          if (command === 'cmd_get_offline_cache_status') return { files: [], total_bytes: 0, max_bytes: 1_000_000_000 };
          if (command === 'cmd_get_installation_info') return { managedByPackageManager: options.packageManaged ?? false, packageManager: options.packageManaged ? 'pacman' : null };
          if (command === 'plugin:updater|check') return state.update ? { rid: 100, currentVersion: '3.9.0', version: '3.9.6', body: 'Reliability update' } : null;
          if (command === 'plugin:updater|download') {
            args.onEvent.onmessage({ event: 'Started', data: { contentLength: 4 } });
            args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: state.incompleteDownload ? 2 : 4 } });
            args.onEvent.onmessage({ event: 'Finished' });
            return 101;
          }
          if (command === 'plugin:updater|install') { if (state.installFails) throw new Error('Disk unavailable'); return; }
          return null;
        },
      },
    });
  }, options);
}

export async function nativeCalls(page: Page, command: string) {
  return page.evaluate(command => (window as any).__desktopTest.calls.filter((call: any) => call.command === command), command);
}

export async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Preferences', exact: true }).click();
}
