import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { VideoMetadata } from '../types';

const METADATA_STALE_TIME = 30 * 60 * 1000; // 30 minutes — metadata rarely changes

/**
 * Fetches MP4 video metadata (duration, resolution) from the Rust backend.
 * Only fires for .mp4 files; returns null for non-video files.
 * Results are cached by React Query for 30 minutes.
 */
export function useVideoMetadata(
    messageId: number,
    folderId: number | null,
    fileName: string,
) {
    const isMp4 = fileName.toLowerCase().endsWith('.mp4');

    return useQuery({
        queryKey: ['video-metadata', folderId, messageId],
        queryFn: async (): Promise<VideoMetadata | null> => {
            if (!isMp4) return null;
            try {
                return await invoke<VideoMetadata>('cmd_get_video_metadata', {
                    messageId,
                    folderId,
                });
            } catch {
                // Metadata unavailable (moov-at-end, non-MP4, network error, etc.)
                return null;
            }
        },
        enabled: isMp4,
        staleTime: METADATA_STALE_TIME,
        retry: 1,
    });
}
