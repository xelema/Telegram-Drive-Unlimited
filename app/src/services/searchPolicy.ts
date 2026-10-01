export type SearchTypeFacet = 'all' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
export type SearchSizeFacet = 'any' | 'small' | 'medium' | 'large';
export type SearchDateFacet = 'any' | '7d' | '30d' | '1y';

const EXTENSIONS_BY_TYPE: Readonly<Record<Exclude<SearchTypeFacet, 'all' | 'other'>, readonly string[]>> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'svg'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  audio: ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
};

export const SMALL_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const MEDIUM_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
export const MILLISECONDS_PER_DAY = 86_400_000;

export function classifyFileExtension(extension: string): Exclude<SearchTypeFacet, 'all'> {
  const normalized = extension.toLowerCase();
  for (const [type, extensions] of Object.entries(EXTENSIONS_BY_TYPE)) {
    if (extensions.includes(normalized)) return type as Exclude<SearchTypeFacet, 'all' | 'other'>;
  }
  return 'other';
}

export function matchesSizeFacet(size: number, facet: SearchSizeFacet): boolean {
  if (facet === 'small') return size < SMALL_FILE_LIMIT_BYTES;
  if (facet === 'medium') return size >= SMALL_FILE_LIMIT_BYTES && size < MEDIUM_FILE_LIMIT_BYTES;
  if (facet === 'large') return size >= MEDIUM_FILE_LIMIT_BYTES;
  return true;
}

export function dateFacetDays(facet: Exclude<SearchDateFacet, 'any'>): number {
  if (facet === '7d') return 7;
  if (facet === '30d') return 30;
  return 365;
}
