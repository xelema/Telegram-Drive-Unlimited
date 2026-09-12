import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { TelegramFile } from '../types';
import { nativeShareOrCopy } from '../utils';
import { sourceFolder } from '../services/fileIdentity';
import { createOwnedShareLinks, type ShareLink } from '../services/shareLinks';
import { useActionScope } from './useActionScope';

type ShareTarget = { ownerId: string; file: TelegramFile };
type BulkShares = { ownerId: string; request: number; links: ShareLink[]; loading: boolean; copied: Set<string> };
const noCopiedLinks = new Set<string>();

/** Desktop and mobile share the same initiating-account boundary. */
export function useFileSharing(ownerId: string | null, folderId: number | null) {
    const capture = useActionScope(ownerId);
    const [target, setTarget] = useState<ShareTarget | null>(null);
    const [bulk, setBulk] = useState<BulkShares | null>(null);
    const requestId = useRef(0);
    useEffect(() => { setTarget(null); setBulk(null); requestId.current++; }, [ownerId]);
    const shareTarget = target?.ownerId === ownerId ? target : null;
    const visibleBulk = bulk?.ownerId === ownerId ? bulk : null;

    const setShareFile = useCallback((file: TelegramFile | null) => {
        const isCurrent = capture();
        if (!isCurrent()) return;
        setTarget(file && ownerId ? { ownerId, file: { ...file, folder_id: sourceFolder(file, folderId) } } : null);
    }, [capture, folderId, ownerId]);
    const setBulkShareLinks = useCallback((_closed: null) => {
        const isCurrent = capture();
        if (!isCurrent()) return;
        requestId.current++; setBulk(null);
    }, [capture]);

    const createBulkShares = useCallback(async (files: TelegramFile[], onCreated: () => void) => {
        const ownerIsCurrent = capture();
        if (!ownerId || !ownerIsCurrent()) return;
        if (!files.length) { toast.info('No shareable files selected (folders cannot be shared)'); return; }
        const request = ++requestId.current;
        const isCurrent = () => ownerIsCurrent() && requestId.current === request;
        setBulk({ ownerId, request, links: [], loading: true, copied: new Set() });
        const result = await createOwnedShareLinks(ownerId, files, folderId, isCurrent);
        if (!isCurrent()) return;
        for (const { file, error } of result.errors) toast.error(`Failed to share ${file.name}: ${error}`);
        if (result.links.length) {
            setBulk({ ownerId, request, links: result.links, loading: false, copied: new Set() });
            onCreated();
        } else {
            setBulk(null);
            toast.error('Failed to generate any share links');
        }
    }, [capture, folderId, ownerId]);

    const handleCopyBulkLink = useCallback((link: string) => {
        const isCurrent = capture();
        const request = visibleBulk?.request;
        if (!isCurrent() || !visibleBulk?.links.some(value => value.link === link)) return;
        void navigator.clipboard.writeText(link).then(() => {
            if (!isCurrent() || requestId.current !== request) return;
            setBulk(value => value?.request === request ? { ...value, copied: new Set(value.copied).add(link) } : value);
            window.setTimeout(() => {
                if (!isCurrent() || requestId.current !== request) return;
                setBulk(value => {
                    if (!value || value.request !== request) return value;
                    const copied = new Set(value.copied); copied.delete(link);
                    return { ...value, copied };
                });
            }, 2000);
        }).catch(() => undefined);
    }, [capture, visibleBulk]);

    const handleNativeShareBulkLink = useCallback((file: TelegramFile, link: string) => {
        const isCurrent = capture();
        if (!isCurrent() || !visibleBulk?.links.some(value => value.link === link)) return;
        nativeShareOrCopy(file.name, file.sizeStr, link, () => { if (isCurrent()) handleCopyBulkLink(link); });
    }, [capture, handleCopyBulkLink, visibleBulk]);

    return {
        shareFile: shareTarget?.file ?? null, shareOwnerId: shareTarget?.ownerId ?? null, setShareFile,
        bulkShareLinks: visibleBulk?.links ?? null, bulkShareLoading: visibleBulk?.loading ?? false,
        bulkShareCopied: visibleBulk?.copied ?? noCopiedLinks, setBulkShareLinks,
        createBulkShares, handleCopyBulkLink, handleNativeShareBulkLink,
    };
}
