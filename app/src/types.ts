export interface TelegramFile {
    id: number;
    name: string;
    size: number;
    sizeStr: string; // Formatted size
    created_at?: string;
    type?: 'folder' | 'file'; // implied icon_type
    folder_id?: number | null;
    // Encryption info
    encryption?: FileEncryptionInfo;
    encryption_state?: EncryptionState;
}

export interface TelegramFolder {
    id: number;
    name: string;
    parent_id?: number;
    username?: string;
    /** Whether the channel has a public username set */
    is_public?: boolean;
    group_id?: number | null;
    display_order?: number;
}

export interface FolderGroup {
    id: number;
    name: string;
    color_hex: string;
    display_order: number;
}

export interface FolderInviteInfo {
    link: string;
    is_public: boolean;
    username?: string;
}

export interface QueueItem {
    id: string;
    path: string;
    url?: string;
    folderId: number | null;
    status: 'pending' | 'downloading' | 'uploading' | 'success' | 'error' | 'cancelled' | 'waiting_for_unlock' | 'encrypting' | 'decrypting' | 'verifying';
    error?: string;
    progress?: number; // 0-100
    uploadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    tempZipPath?: string; // Set when the upload originated from a zipped folder
    // Encryption
    protection?: UploadProtectionIntent;
}

export interface BandwidthStats {
    up_bytes: number;
    down_bytes: number;
}

export interface DownloadItem {
    id: string;
    messageId: number;
    filename: string;
    folderId: number | null;
    status: 'pending' | 'downloading' | 'success' | 'error' | 'cancelled' | 'waiting_for_unlock' | 'decrypting' | 'verifying';
    error?: string;
    progress?: number; // 0-100
    downloadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    savePath?: string;
    protectionMode?: 'vault' | 'passphrase' | 'vault_and_passphrase';
    /** In-memory only. Never persist this single-use credential handle. */
    promptToken?: number;
}
export interface ShareInfo {
    id: string;
    folder_id: number | null;
    message_id: number;
    file_name: string;
    file_size: number;
    created_at: number;
    expires_at: number | null;
    revoked: boolean;
    has_password: boolean;
    link: string;
}

// ── Adaptive streaming types ─────────────────────────────────────────

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
    'original': 0,
};

/** Thresholds for adaptive quality switching (check from highest to lowest). */
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
    'original': 'Original',
};

export const HLS_QUALITIES: StreamingQuality[] = ['360p', '480p', '720p', '1080p'];

// ── Transcode types (HLS backend) ────────────────────────────────────

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

// ── Encryption types ────────────────────────────────────────────────

export type EncryptionState =
    | 'plain'
    | 'encrypted_unlocked'
    | 'encrypted_locked'
    | 'encrypted_key_missing'
    | 'encrypted_unsupported_version'
    | 'encrypted_corrupt'
    | 'encrypted_verifying';

export interface FileEncryptionInfo {
    state: EncryptionState;
    envelope_version?: number;
    profile_id?: string;
    protection_mode?: 'vault' | 'passphrase' | 'vault_and_passphrase';
    metadata_protected?: boolean;
    ciphertext_size?: number;
}

export interface UploadProtectionIntent {
    mode: 'standard' | 'vault' | 'passphrase' | 'vault_and_passphrase';
    profileId?: string;
    protectMetadata?: boolean;
    /** In-memory only. Never serialize this short-lived, single-use handle. */
    promptToken?: number;
}

export interface EncryptionCapabilities {
    contract_version: number;
    app_version: string;
    backend_build_id: string;
    availability: 'disabled' | 'development' | 'blocked' | 'ready';
    blockers: string[];
    vault_backend: 'stronghold' | 'persistent_file' | 'test_memory' | 'none';
    readable_formats: number[];
    writable_formats: number[];
    features: {
        upload: boolean;
        read: boolean;
        per_file_passphrase: boolean;
        recovery: boolean;
        share: boolean;
        migration: boolean;
    };
    core_available: boolean;
    mode_alpha: boolean;
    upload_enabled: boolean;
    read_enabled: boolean;
    share_enabled: boolean;
    migration_enabled: boolean;
    supported_suites: number[];
    envelope_version: number;
}

export type EncryptionCapabilityState = 'loading' | 'ready' | 'blocked' | 'disabled' | 'error';

export interface CryptoInventoryEntry {
    envelope_version: number;
    file_count: number;
    ciphertext_bytes: number;
}

export interface CryptoInventory {
    entries: CryptoInventoryEntry[];
    total_files: number;
    total_ciphertext_bytes: number;
    vault_exists: boolean;
    experimental_format_quarantined: boolean;
}

export interface EncryptionSettings {
    default_mode: string;
    protect_metadata: boolean;
    auto_lock_minutes: number;
    lock_on_sleep: boolean;
    temp_policy: string;
    remember_device: boolean;
}

export interface VaultStatus {
    exists: boolean;
    is_unlocked: boolean;
    session_id: number | null;
    has_recovery: boolean;
    created_at: string | null;
}

// ── Rust command return types ────────────────────────────────────────

export interface ArchiveEntry {
    filename: string;
    size: number;
    compressed_size: number;
    is_dir: boolean;
}

export interface VideoMetadata {
    duration_secs: number | null;
    video_codec: string | null;
    has_audio: boolean;
    track_count: number;
    width: number | null;
    height: number | null;
}
