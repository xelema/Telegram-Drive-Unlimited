import { describe, expect, it } from 'vitest';
import { filterWorkspaceFiles, groupTimeline, workspaceFileKey, type WorkspaceFile } from '../../src/services/workspace';
import { DEFAULT_SEARCH_FILTERS } from '../../src/services/fileSearch';

const file = (id: number, folder_id: number | null, overrides: Partial<WorkspaceFile> = {}): WorkspaceFile => ({ id, folder_id, key: workspaceFileKey({ id, folder_id }), name: 'Invoice.pdf', size: 500, sizeStr: '500 B', created_at: '2026-09-10T10:00:00Z', folderName: 'Work', collectionIds: ['work'], tags: ['Receipt'], ...overrides });
describe('personal workspace', () => {
    it('preserves Saved Messages rather than substituting a current channel', () => {
        expect(workspaceFileKey({ id: 42, folder_id: null }, 9)).toBe('saved:42');
        expect(workspaceFileKey({ id: 42 }, 9)).toBe('9:42');
    });
    it('combines a saved search with collection, tags and folder rules', () => {
        const files = [file(1, null), file(1, 8), file(2, 8, { collectionIds: [], tags: [] })];
        expect(filterWorkspaceFiles(files, 'invoice', DEFAULT_SEARCH_FILTERS, 'work', ['receipt'], 8).map(f => f.key)).toEqual(['8:1']);
        expect(filterWorkspaceFiles(files, 'invoice', DEFAULT_SEARCH_FILTERS, 'work', [], null).map(f => f.key)).toEqual(['saved:1']);
    });
    it('groups by uploaded month and keeps unknown dates separate without dropping files', () => {
        const groups = groupTimeline([file(1, null), file(2, null, { created_at: '2026-08-15T12:00:00Z' }), file(3, null, { created_at: '' })]);
        expect(groups.map(g => g.month)).toEqual(['2026-09', '2026-08', 'unknown']);
        expect(groups.flatMap(g => g.files).length).toBe(3);
    });
});
