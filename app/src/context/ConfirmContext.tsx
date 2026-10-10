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

/** A masked, in-app request for a passphrase. The value never leaves memory. */
export interface SecretPromptOptions {
    title: string;
    message?: string;
    /** Ask for the value twice; use this when a new passphrase is being chosen. */
    confirmEntry?: boolean;
    /** Minimum length in UTF-8 bytes, matching the backend policy. */
    minBytes?: number;
    confirmText?: string;
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
    chooseDownloadCollision: () => Promise<DownloadCollisionPolicy | null>;
    /** Resolves with the entered secret, or null when the request is dismissed. */
    promptSecret: (options: SecretPromptOptions) => Promise<string | null>;
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
    const [secretOptions, setSecretOptions] = useState<SecretPromptOptions | null>(null);
    const secretResolve = useRef<((value: string | null) => void) | null>(null);
    const finishSecret = (value: string | null) => {
        setSecretOptions(null);
        secretResolve.current?.(value);
        secretResolve.current = null;
    };
    const promptSecret = (opts: SecretPromptOptions) => {
        // Only one credential request is shown at a time; a newer request
        // dismisses the older one instead of stacking dialogs.
        secretResolve.current?.(null);
        setSecretOptions(opts);
        return new Promise<string | null>(resolve => { secretResolve.current = resolve; });
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
        <ConfirmContext.Provider value={{ confirm, chooseDownloadCollision, promptSecret }}>
            {children}
            {(isOpen || collisionOpen || secretOptions) && <Suspense fallback={null}>
                <ConfirmationDialogs isOpen={isOpen} collisionOpen={collisionOpen} options={options}
                    secretOptions={secretOptions} onSecret={finishSecret}
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
