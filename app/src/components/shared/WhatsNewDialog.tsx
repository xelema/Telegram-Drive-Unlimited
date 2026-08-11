import { useRef } from 'react';
import { CheckCircle2, Sparkles, X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { WhatsNewDetails } from '../../services/updateReliability';

export function WhatsNewDialog({ details, onClose }: { details: WhatsNewDetails; onClose: () => void }) {
    const panelRef = useRef<HTMLDivElement>(null);
    useModalFocus(panelRef, onClose);

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="presentation">
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="whats-new-title" tabIndex={-1} className="w-full max-w-lg rounded-overlay border border-app-border bg-app-surface p-6 text-app-text shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <span className="rounded-full bg-app-selected p-2 text-app-accent"><Sparkles className="h-5 w-5" /></span>
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-app-accent">Update complete</p>
                            <h2 id="whats-new-title" className="mt-1 text-xl font-semibold">What&apos;s new in {details.version}</h2>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close What's New" className="quiet-control rounded p-2 text-app-text-secondary hover:bg-app-hover hover:text-app-text"><X className="h-4 w-4" /></button>
                </div>
                <div className="mt-5 rounded-control border border-app-border-subtle bg-app-surface-sunken p-4 text-sm leading-6 text-app-text-secondary whitespace-pre-wrap">
                    {details.body?.trim() || 'Telegram Drive was updated successfully. This release includes reliability, security, and interface improvements.'}
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs text-app-text-secondary"><CheckCircle2 className="h-4 w-4 text-app-success" />The signed update was verified before installation.</div>
                <button type="button" onClick={onClose} className="quiet-control mt-6 w-full rounded-control bg-app-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90">Continue</button>
            </div>
        </div>
    );
}
