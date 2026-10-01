import { createContext, useContext, type ReactNode } from 'react';
import { useUpdateCheck } from '../hooks/useUpdateCheck';

const UpdateContext = createContext<ReturnType<typeof useUpdateCheck> | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
    const updates = useUpdateCheck();
    return <UpdateContext.Provider value={updates}>{children}</UpdateContext.Provider>;
}

export function useUpdates() {
    const updates = useContext(UpdateContext);
    if (!updates) throw new Error('useUpdates must be used within an UpdateProvider');
    return updates;
}
