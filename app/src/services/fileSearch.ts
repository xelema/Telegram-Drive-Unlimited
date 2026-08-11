import type { TelegramFile } from '../types';
import {
    classifyFileExtension,
    dateFacetDays,
    matchesSizeFacet,
    MILLISECONDS_PER_DAY,
    type SearchDateFacet,
    type SearchSizeFacet,
    type SearchTypeFacet,
} from './searchPolicy';

export type { SearchDateFacet, SearchSizeFacet, SearchTypeFacet } from './searchPolicy';

export interface FileSearchFilters {
    scope: 'folder' | 'all';
    type: SearchTypeFacet;
    size: SearchSizeFacet;
    date: SearchDateFacet;
}

export const DEFAULT_SEARCH_FILTERS: FileSearchFilters = {
    scope: 'folder',
    type: 'all',
    size: 'any',
    date: 'any',
};

function normalized(value: string): string {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

/** Returns a lower score for a better fuzzy match, or null when not matched. */
export function fuzzyScore(name: string, query: string): number | null {
    const candidate = normalized(name);
    const needle = normalized(query.trim());
    if (!needle) return 0;
    const exact = candidate.indexOf(needle);
    if (exact >= 0) return exact;

    let cursor = 0;
    let score = 0;
    let previous = -1;
    for (const character of needle) {
        const index = candidate.indexOf(character, cursor);
        if (index < 0) return null;
        score += previous < 0 ? index : Math.max(0, index - previous - 1);
        previous = index;
        cursor = index + 1;
    }
    return score + Math.max(0, candidate.length - needle.length) * 0.05;
}

function typeFacet(file: TelegramFile): Exclude<SearchTypeFacet, 'all'> {
    const extension = (file.file_ext || file.name.split('.').pop() || '').toLowerCase();
    return classifyFileExtension(extension);
}

function matchesFacets(file: TelegramFile, filters: FileSearchFilters): boolean {
    if (filters.type !== 'all' && typeFacet(file) !== filters.type) return false;
    const size = file.size || 0;
    if (!matchesSizeFacet(size, filters.size)) return false;
    if (filters.date !== 'any') {
        const timestamp = Date.parse(file.created_at || '');
        if (!Number.isFinite(timestamp)) return false;
        const days = dateFacetDays(filters.date);
        if (timestamp < Date.now() - days * MILLISECONDS_PER_DAY) return false;
    }
    return true;
}

export function filterAndRankFiles(files: TelegramFile[], query: string, filters: FileSearchFilters): TelegramFile[] {
    if (!query.trim()) return files.filter((file) => matchesFacets(file, filters));
    return files
        .map((file) => ({ file, score: fuzzyScore(file.name, query) }))
        .filter((entry): entry is { file: TelegramFile; score: number } => entry.score !== null && matchesFacets(entry.file, filters))
        .sort((a, b) => a.score - b.score || a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map(({ file }) => file);
}
