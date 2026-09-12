import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TelegramFile } from '../types';
import { normalizeListedFile } from '../services/fileListRefresh';

interface SearchState {
    ownerId: string | null;
    query: string;
    results: TelegramFile[];
    isSearching: boolean;
}

export function useGlobalFileSearch(query: string, scope: 'folder' | 'all', ownerId: string | null) {
    const normalizedQuery = query.trim();
    const enabled = Boolean(ownerId) && scope === 'all' && normalizedQuery.length >= 2;
    const current = useRef({ ownerId, query: normalizedQuery, enabled });
    current.current = { ownerId, query: normalizedQuery, enabled };
    const [state, setState] = useState<SearchState>({ ownerId: null, query: '', results: [], isSearching: false });

    useEffect(() => {
        let cancelled = false;
        const isCurrent = () => !cancelled && current.current.enabled
            && current.current.ownerId === ownerId && current.current.query === normalizedQuery;
        setState({ ownerId, query: normalizedQuery, results: [], isSearching: false });
        if (!enabled || !ownerId) return;

        const timer = window.setTimeout(async () => {
            if (!isCurrent()) return;
            setState({ ownerId, query: normalizedQuery, results: [], isSearching: true });
            try {
                const results = await invoke<TelegramFile[]>('cmd_search_global', { query: normalizedQuery, ownerId });
                if (isCurrent()) {
                    setState({ ownerId, query: normalizedQuery, results: results.map(normalizeListedFile), isSearching: false });
                }
            } catch {
                if (isCurrent()) {
                    setState({ ownerId, query: normalizedQuery, results: [], isSearching: false });
                }
            }
        }, 500);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [enabled, normalizedQuery, ownerId]);

    // Never render another account's cached results, including the render
    // before effect cleanup and a switch that leaves the query text unchanged.
    return enabled && state.ownerId === ownerId && state.query === normalizedQuery
        ? { results: state.results, isSearching: state.isSearching }
        : { results: [], isSearching: false };
}
