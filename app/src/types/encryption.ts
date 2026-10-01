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
