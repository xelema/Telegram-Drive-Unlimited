import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { searchLocal, type LocalSearchQuery, type LocalSearchReply } from '../services/localSearch';
import type { FileSearchFilters } from '../services/fileSearch';

export function useLocalFileSearch(query: LocalSearchQuery, ownerId: string | null, enabled: boolean, metadataVersion?: unknown) {
    const metadata = useRef({ value: metadataVersion, revision: 0 });
    if (metadata.current.value !== metadataVersion) metadata.current = { value: metadataVersion, revision: metadata.current.revision + 1 };
    const key = JSON.stringify([ownerId, query, metadata.current.revision]);
    const current = useRef(key); current.current = key;
    const generation = useRef(0);
    const [revision, refresh] = useState(0);
    const [state, setState] = useState<{ key: string; reply?: LocalSearchReply; busy: boolean; error?: string }>({ key: '', busy: false });
    useEffect(() => {
        let cancelled = false;
        const reset = () => { if (!cancelled) { generation.current++; setState({ key: '', busy: false }); refresh(value => value + 1); } };
        const listeners = ['vault-locked', 'vault-unlocked', 'file-inventory-changed'].map(event => listen(event, reset));
        return () => { cancelled = true; generation.current++; listeners.forEach(value => { void value.then(dispose => dispose()).catch(() => undefined); }); };
    }, []);
    useEffect(() => {
        const request = ++generation.current;
        const isCurrent = () => generation.current === request && current.current === key;
        setState({ key, busy: enabled });
        if (!enabled || !ownerId) return;
        const timer = window.setTimeout(() => {
            void searchLocal(ownerId, query, isCurrent).then(reply => {
                if (isCurrent()) setState({ key, reply, busy: false });
            }).catch(error => {
                if (isCurrent()) setState({ key, busy: false, error: String(error) });
            });
        }, 300);
        return () => { generation.current++; window.clearTimeout(timer); };
    }, [key, enabled, revision]); // The serialized key includes every query field and metadata version.
    const visible = enabled && state.key === key ? state : undefined;
    return { results: visible?.reply?.files ?? [], isSearching: visible?.busy ?? false, reply: visible?.reply, error: visible?.error };
}
export function useGlobalFileSearch(query: string, filters: FileSearchFilters, ownerId: string | null) {
    return useLocalFileSearch({ ...filters, query: query.trim() }, ownerId, filters.scope === 'all');
}
