const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'opus'] as const;
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'] as const;

const endsWithAny = (name: string, extensions: readonly string[]): boolean => {
  const lower = name.toLowerCase();
  return extensions.some(extension => lower.endsWith(extension));
};

export function formatBytes(bytes: number, decimals = 2): string {
  if (!+bytes) return '0 Bytes';
  const base = 1024;
  const precision = decimals < 0 ? 0 : decimals;
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(base));
  return `${parseFloat((bytes / Math.pow(base, unitIndex)).toFixed(precision))} ${units[unitIndex]}`;
}

const hasMimePrefix = (mimeType: string | null | undefined, prefix: string): boolean =>
  typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith(prefix);

export const isVideoFile = (name: string, mimeType?: string | null): boolean =>
  hasMimePrefix(mimeType, 'video/') || endsWithAny(name, VIDEO_EXTENSIONS);
export const isAudioFile = (name: string, mimeType?: string | null): boolean =>
  hasMimePrefix(mimeType, 'audio/') || endsWithAny(name, AUDIO_EXTENSIONS);
export const isMediaFile = (name: string, mimeType?: string | null): boolean =>
  isVideoFile(name, mimeType) || isAudioFile(name, mimeType);
export const isImageFile = (name: string): boolean => endsWithAny(name, IMAGE_EXTENSIONS);
export const isPdfFile = (name: string): boolean => name.toLowerCase().endsWith('.pdf');
export const isZipFile = (name: string): boolean => name.toLowerCase().endsWith('.zip');
export const isRarFile = (name: string): boolean => name.toLowerCase().endsWith('.rar');
export const isSevenZFile = (name: string): boolean => name.toLowerCase().endsWith('.7z');
export const isArchiveFile = (name: string): boolean => isZipFile(name) || isRarFile(name) || isSevenZFile(name);

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    || 'file';
}
