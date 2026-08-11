import { createContext, useContext, useState, ReactNode, useRef } from 'react';
import { useModalFocus } from '../hooks/useModalFocus';
import { triggerHaptic } from '../services/feedback';

interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'info';
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [options, setOptions] = useState<ConfirmOptions>({ title: '', message: '' });
    const [resolveRef, setResolveRef] = useState<((value: boolean) => void) | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

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
    useModalFocus(panelRef, handleCancel, isOpen);

    return (
        <ConfirmContext.Provider value={{ confirm }}>
            {children}
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" tabIndex={-1} className="bg-[#1c1c1c] border border-white/10 rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
                        <h3 id="confirm-dialog-title" className="text-lg font-medium text-white mb-2">{options.title}</h3>
                        <p className="text-telegram-subtext text-sm mb-6 whitespace-pre-line">{options.message}</p>
                        <div className="flex justify-end gap-3">
                            <button onClick={handleCancel} className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/5 text-telegram-subtext transition">
                                {options.cancelText || 'Cancel'}
                            </button>
                            <button
                                onClick={handleConfirm}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${options.variant === 'danger' ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-telegram-primary text-white hover:bg-telegram-primary/90'}`}
                            >
                                {options.confirmText || 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </ConfirmContext.Provider>
    );
}

export const useConfirm = () => {
    const context = useContext(ConfirmContext);
    if (!context) throw new Error('useConfirm must be used within a ConfirmProvider');
    return context;
};
