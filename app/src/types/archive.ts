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
