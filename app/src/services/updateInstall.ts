import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { writePendingUpdate, clearPendingUpdate, type UpdateInstallPhase } from './updateReliability';

export async function installVerifiedUpdate(
    update: Update,
    onProgress: (progress: number) => void,
    onPhase?: (phase: UpdateInstallPhase) => void,
): Promise<void> {
    let downloadedBytes = 0;
    let contentLength: number | undefined;
    let finished = false;

    onPhase?.('downloading');
    await update.download((event: DownloadEvent) => {
        if (event.event === 'Started') {
            contentLength = event.data.contentLength;
            downloadedBytes = 0;
        } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength;
            if (contentLength && contentLength > 0) {
                onProgress(Math.min(99, Math.round((downloadedBytes / contentLength) * 100)));
            }
        } else if (event.event === 'Finished') {
            finished = true;
        }
    });

    onPhase?.('verifying');
    if (!finished) {
        throw new Error('The update download did not finish. Your current version was left unchanged.');
    }
    if (contentLength && downloadedBytes !== contentLength) {
        throw new Error(
            `Update verification failed: expected ${contentLength} bytes but received ${downloadedBytes}. Your current version was left unchanged.`,
        );
    }

    // Tauri verifies the updater signature during download. Installation is only
    // attempted after its Finished event and our byte-count consistency check.
    onProgress(100);
    writePendingUpdate(update);
    onPhase?.('installing');
    try {
        await update.install();
        await relaunch();
    } catch (error) {
        clearPendingUpdate();
        throw error;
    }
}
