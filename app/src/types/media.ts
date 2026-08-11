export type StreamingQuality = '360p' | '480p' | '720p' | '1080p' | 'original';

export interface StreamingSettings {
  quality: StreamingQuality;
  adaptiveMode: boolean;
}

export interface VideoTrackInfo {
  id: number;
  type: 'video' | 'audio';
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
  duration?: number;
}

/** Bandwidth cap in kilobits per second for each quality preset. 0 = unlimited. */
export const QUALITY_THROTTLE_MAP: Record<StreamingQuality, number> = {
  '360p': 500,
  '480p': 1000,
  '720p': 2500,
  '1080p': 5000,
  original: 0,
};

/** Thresholds for adaptive quality switching, ordered highest to lowest. */
export const ADAPTIVE_THRESHOLDS: { minKbps: number; quality: StreamingQuality }[] = [
  { minKbps: 4000, quality: '1080p' },
  { minKbps: 2000, quality: '720p' },
  { minKbps: 800, quality: '480p' },
  { minKbps: 0, quality: '360p' },
];

export const QUALITY_LABELS: Record<StreamingQuality, string> = {
  '360p': '360p',
  '480p': '480p',
  '720p': '720p',
  '1080p': '1080p',
  original: 'Original',
};

export const HLS_QUALITIES: StreamingQuality[] = ['360p', '480p', '720p', '1080p'];

export interface TranscodeCapabilities {
  available: boolean;
  variants: QualityVariant[];
  mode: 'hls' | 'original';
}

export interface QualityVariant {
  label: string;
  height: number;
  available: boolean;
}

export interface TranscodePrepareResult {
  job_id: string;
  status: 'started' | 'pending' | 'caching' | 'transcoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  playlist_url: string | null;
}

export interface TranscodeStatusResult {
  job_id: string;
  status: 'pending' | 'caching' | 'transcoding' | 'ready' | 'error' | 'cancelled';
  progress: number;
  error: string | null;
  playlist_url: string | null;
}

export interface MasterPlaylistInfo {
  file_key: string;
  variants: MasterVariant[];
  master_playlist_url: string | null;
}

export interface MasterVariant {
  bandwidth: number;
  resolution: string;
  quality: string;
  playlist_path: string;
}

export interface CacheEntry {
  file_key: string;
  quality: string;
  size_bytes: number;
  playlist_exists: boolean;
}

export interface DetailedCacheInfo {
  entries: CacheEntry[];
  total_bytes: number;
  max_bytes: number;
}

export type TranscodeJobPhase = 'idle' | 'preparing' | 'caching' | 'transcoding' | 'ready' | 'failed';
