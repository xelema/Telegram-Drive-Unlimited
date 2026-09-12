import { createContext, lazy, Suspense, useContext, useState, ReactNode, useRef } from 'react';
import { triggerHaptic } from '../services/feedback';
import type { DownloadCollisionPolicy } from '../types/transfers';

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'info';
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
    chooseDownloadCollision: () => Promise<DownloadCollisionPolicy | null>;
}

const ConfirmationDialogs = lazy(() => import('../components/shared/ConfirmationDialogs'));

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [options, setOptions] = useState<ConfirmOptions>({ title: '', message: '' });
    const [resolveRef, setResolveRef] = useState<((value: boolean) => void) | null>(null);
    const [collisionOpen, setCollisionOpen] = useState(false);
    const collisionResolve = useRef<((value: DownloadCollisionPolicy | null) => void) | null>(null);
    const finishCollision = (value: DownloadCollisionPolicy | null) => {
        setCollisionOpen(false);
        collisionResolve.current?.(value);
        collisionResolve.current = null;
    };
    const chooseDownloadCollision = () => {
        collisionResolve.current?.(null);
        setCollisionOpen(true);
        return new Promise<DownloadCollisionPolicy | null>(resolve => { collisionResolve.current = resolve; });
    };

    const confirm = (opts: ConfirmOptions) => {
        if (opts.variant === 'danger') triggerHaptic('warning');
        setOptions(opts);
        setIsOpen(true);
        return new Promise<boolean>((resolve) => {
            setResolveRef(() => resolve);
        });
    };

    const handleConfirm = () => {
        triggerHaptic(options.variant === 'danger' ? 'warning' : 'success');
        setIsOpen(false);
        if (resolveRef) resolveRef(true);
    };

    const handleCancel = () => {
        setIsOpen(false);
        if (resolveRef) resolveRef(false);
    };

    return (
        <ConfirmContext.Provider value={{ confirm, chooseDownloadCollision }}>
            {children}
            {(isOpen || collisionOpen) && <Suspense fallback={null}>
                <ConfirmationDialogs isOpen={isOpen} collisionOpen={collisionOpen} options={options}
                    onConfirm={handleConfirm} onCancel={handleCancel} onCollision={finishCollision} />
            </Suspense>}
        </ConfirmContext.Provider>
    );
}

export const useConfirm = () => {
    const context = useContext(ConfirmContext);
    if (!context) throw new Error('useConfirm must be used within a ConfirmProvider');
    return context;
};
