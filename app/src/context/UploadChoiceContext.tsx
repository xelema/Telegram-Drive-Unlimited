import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { LockKeyhole, UploadCloud } from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import i18n from '../i18n';

export type UploadChoice = 'store' | 'protect';

interface UploadChoiceContextValue {
    chooseUploadProtection: (count: number) => Promise<UploadChoice | null>;
}

const UploadChoiceContext = createContext<UploadChoiceContextValue | null>(null);

export function UploadChoiceProvider({ children }: { children: ReactNode }) {
    const [request, setRequest] = useState<{ count: number; resolve: (choice: UploadChoice | null) => void } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const finish = useCallback((choice: UploadChoice | null) => {
        request?.resolve(choice);
        setRequest(null);
    }, [request]);
    useModalFocus(panelRef, () => finish(null), !!request);

    const chooseUploadProtection = useCallback((count: number) => new Promise<UploadChoice | null>((resolve) => {
        setRequest({ count, resolve });
    }), []);

    return (
        <UploadChoiceContext.Provider value={{ chooseUploadProtection }}>
            {children}
            {request && (
                <div className="fixed inset-0 z-[250] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
                    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="upload-choice-title" tabIndex={-1} className="quiet-raised w-[min(520px,calc(100vw-2rem))] p-5">
                        <h2 id="upload-choice-title" className="text-lg font-semibold text-app-text">How should we store {request.count === 1 ? 'this file' : `these ${request.count} files`}?</h2>
                        <p className="mt-1 text-sm text-app-text-secondary">You can keep the original file, or protect it with Telegram Drive encryption before upload.</p>
                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <button onClick={() => finish('store')} className="quiet-surface p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                                <UploadCloud className="mb-3 h-5 w-5 text-app-accent" />
                                <span className="block text-sm font-semibold text-app-text">Store</span>
                                <span className="mt-1 block text-xs leading-5 text-app-text-secondary">Upload normally for maximum compatibility and easy sharing.</span>
                            </button>
                            <button onClick={() => finish('protect')} className="quiet-surface p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                                <LockKeyhole className="mb-3 h-5 w-5 text-app-success" />
                                <span className="block text-sm font-semibold text-app-text">Store &amp; protect</span>
                                <span className="mt-1 block text-xs leading-5 text-app-text-secondary">Encrypt before upload using your configured protection settings.</span>
                            </button>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <button onClick={() => finish(null)} className="quiet-control px-4 py-2.5 text-sm font-medium text-app-text-secondary hover:text-app-text">{i18n.t("common.cancel")}</button>
                        </div>
                    </div>
                </div>
            )}
        </UploadChoiceContext.Provider>
    );
}

export function useUploadChoice() {
    const value = useContext(UploadChoiceContext);
    if (!value) throw new Error('useUploadChoice must be used within UploadChoiceProvider');
    return value;
}
