import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCurrentAccountId } from '../services/currentAccount';
import { indexWorkspace, mutateWorkspace, readWorkspace, type WorkspaceMutation } from '../services/workspace';

export function useWorkspace() {
    const queryClient = useQueryClient();
    const [ownerId, setOwnerId] = useState<string | null>(null);
    const [accountError, setAccountError] = useState<string | null>(null);
    const [indexing, setIndexing] = useState(false);
    const currentOwner = useRef(ownerId); currentOwner.current = ownerId;
    const lookupGeneration = useRef(0);
    const mutationGeneration = useRef(0);
    const indexGeneration = useRef(0);
    const refreshAccount = useCallback(async () => {
        const request = ++lookupGeneration.current;
        try {
            const id = await getCurrentAccountId();
            if (request !== lookupGeneration.current) return;
            currentOwner.current = id;
            setOwnerId(id); setAccountError(null);
        } catch (error) {
            if (request !== lookupGeneration.current) return;
            currentOwner.current = null;
            setOwnerId(null); setAccountError(String(error));
        }
    }, []);
    useEffect(() => {
        const check = () => { void refreshAccount(); };
        check(); document.addEventListener('visibilitychange', check);
        return () => { lookupGeneration.current++; document.removeEventListener('visibilitychange', check); };
    }, [refreshAccount]);
    const query = useQuery({ queryKey: ['workspace', ownerId], queryFn: () => readWorkspace(ownerId!), enabled: !!ownerId, refetchInterval: indexing ? 1000 : false });
    const accountFailure = useCallback((error: unknown, requestOwner: string) => {
        if (currentOwner.current === requestOwner && String(error).includes('ACCOUNT_')) {
            lookupGeneration.current++;
            currentOwner.current = null; setOwnerId(null); setAccountError(String(error));
        }
    }, []);
    useEffect(() => { if (ownerId && query.error) accountFailure(query.error, ownerId); }, [ownerId, query.error, accountFailure]);
    const mutate = useCallback(async (mutation: WorkspaceMutation) => {
        if (!ownerId) throw new Error('ACCOUNT_REQUIRED');
        const generation = ++mutationGeneration.current;
        // A read started before this write must not overwrite its newer result.
        await queryClient.cancelQueries({ queryKey: ['workspace', ownerId], exact: true });
        try {
            const next = await mutateWorkspace(ownerId, mutation);
            if (currentOwner.current === ownerId && generation === mutationGeneration.current) queryClient.setQueryData(['workspace', ownerId], next);
        } catch (error) { accountFailure(error, ownerId); throw error; }
        finally {
            if (currentOwner.current === ownerId && generation === mutationGeneration.current) void queryClient.invalidateQueries({ queryKey: ['workspace', ownerId], exact: true });
        }
    }, [ownerId, queryClient, accountFailure]);
    const index = useCallback(async (folderIds: (number | null)[]) => {
        if (!ownerId) throw new Error('ACCOUNT_REQUIRED');
        const request = ++indexGeneration.current;
        const generation = mutationGeneration.current;
        setIndexing(true);
        try {
            const next = await indexWorkspace(ownerId, folderIds);
            if (currentOwner.current === ownerId && request === indexGeneration.current && generation === mutationGeneration.current) queryClient.setQueryData(['workspace', ownerId], next);
        } catch (error) { accountFailure(error, ownerId); throw error; }
        finally {
            if (request === indexGeneration.current) setIndexing(false);
            void queryClient.invalidateQueries({ queryKey: ['workspace', ownerId], exact: true });
        }
    }, [ownerId, queryClient, accountFailure]);
    return { ...query, ownerId, accountError, indexing, mutate, index, refreshAccount };
}
