import { Component, createContext, lazy, type ReactNode, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useModalFocus } from '../hooks/useModalFocus';
import i18n from '../i18n';

export type UploadChoice = 'store' | 'protect';
interface UploadChoiceContextValue {
    chooseUploadProtection: (count: number) => Promise<UploadChoice | null>;
}
const UploadChoiceContext = createContext<UploadChoiceContextValue | null>(null);
const Dialog = lazy(() => import('../components/shared/UploadProtectionDialog'));

class UploadDialogBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function PendingUploadDialog({ failed = false, retry }: { failed?: boolean; retry: () => void }) {
    return <div>
        <p id="upload-choice-title" role={failed ? 'alert' : 'status'} className="text-sm text-app-text">{i18n.t(failed ? 'upload_choice_copy.load_failed' : 'common.loading')}</p>
        {failed && <button type="button" onClick={retry} className="quiet-control mt-4 min-h-11 px-4 text-sm text-app-accent">{i18n.t('upload_choice_copy.reload_app')}</button>}
    </div>;
}

export function UploadChoiceProvider({ children }: { children: ReactNode }) {
    const [request, setRequest] = useState<{ count: number; id: number; resolve: (choice: UploadChoice | null) => void } | null>(null);
    const requestRef = useRef(request);
    const nextId = useRef(0);
    const panelRef = useRef<HTMLDivElement>(null);
    const finish = useCallback((choice: UploadChoice | null, expectedId?: number) => {
        if (expectedId !== undefined && requestRef.current?.id !== expectedId) return;
        requestRef.current?.resolve(choice);
        requestRef.current = null;
        setRequest(null);
    }, []);
    useModalFocus(panelRef, () => finish(null), !!request);
    useEffect(() => () => { requestRef.current?.resolve(null); requestRef.current = null; }, []);
    const chooseUploadProtection = useCallback((count: number) => new Promise<UploadChoice | null>((resolve) => {
        const nextRequest = { count, id: ++nextId.current, resolve };
        requestRef.current?.resolve(null);
        requestRef.current = nextRequest;
        setRequest(nextRequest);
    }), []);
    const reloading = useRef(false);
    const retry = (requestId: number) => {
        if (reloading.current || requestRef.current?.id !== requestId) return;
        reloading.current = true;
        finish(null, requestId);
        window.location.reload();
    };
    return <UploadChoiceContext.Provider value={{ chooseUploadProtection }}>
        {children}
        {request && <div className="fixed inset-0 z-[250] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="upload-choice-title" tabIndex={-1} className="quiet-raised max-h-[calc(100dvh-2rem)] w-[min(520px,calc(100vw-2rem))] overflow-y-auto p-5">
                <UploadDialogBoundary key={request.id} fallback={<PendingUploadDialog failed retry={() => retry(request.id)} />}>
                    <Suspense fallback={<PendingUploadDialog retry={() => retry(request.id)} />}>
                        <Dialog count={request.count} onFinish={choice => { if (requestRef.current?.id === request.id) finish(choice); }} />
                    </Suspense>
                </UploadDialogBoundary>
                <div className="mt-4 flex justify-end"><button type="button" onClick={() => finish(null, request.id)} className="quiet-control min-h-11 px-4 text-sm text-app-text-secondary">{i18n.t('common.cancel')}</button></div>
            </div>
        </div>}

    </UploadChoiceContext.Provider>;
}

export function useUploadChoice() {
    const value = useContext(UploadChoiceContext);
    if (!value) throw new Error('useUploadChoice must be used within UploadChoiceProvider');
    return value;
}
