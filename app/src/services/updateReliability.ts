import type { Update } from '@tauri-apps/plugin-updater';

const PENDING_UPDATE_KEY = 'telegram-drive.pending-update';
const LAST_SEEN_VERSION_KEY = 'telegram-drive.last-seen-version';

export type UpdateInstallPhase = 'downloading' | 'verifying' | 'installing';

export interface WhatsNewDetails {
    version: string;
    body?: string;
    updated: boolean;
}

interface PendingUpdate {
    toVersion: string;
    body?: string;
}

export function writePendingUpdate(update: Update): void {
    const pending: PendingUpdate = {
        toVersion: update.version,
        body: update.body,
    };
    try {
        localStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify(pending));
    } catch {
        // Optional release notes must never prevent a verified update installing.
    }
}

export function clearPendingUpdate(): void {
    try {
        localStorage.removeItem(PENDING_UPDATE_KEY);
    } catch {
        // Preserve the installation result even when display-history storage fails.
    }
}

export function consumeWhatsNew(currentVersion: string): WhatsNewDetails | null {
    try {
        const lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_KEY);
        localStorage.setItem(LAST_SEEN_VERSION_KEY, currentVersion);

        const rawPending = localStorage.getItem(PENDING_UPDATE_KEY);
        if (rawPending) {
            try {
                const pending = JSON.parse(rawPending) as PendingUpdate | null;
                if (pending?.toVersion === currentVersion) {
                    clearPendingUpdate();
                    return { version: currentVersion, body: typeof pending.body === 'string' ? pending.body : undefined, updated: true };
                }
            } catch {
                clearPendingUpdate();
            }
        }

        if (lastSeenVersion && lastSeenVersion !== currentVersion) {
            return { version: currentVersion, updated: true };
        }
    } catch {
        // Startup does not depend on being able to show release-note history.
    }
    return null;
}
