import { useCallback, useRef } from 'react';
import { Command, X } from 'lucide-react';
import { useModalFocus } from '../../../hooks/useModalFocus';

const shortcuts = [
    ['⌘/Ctrl F', 'Search files'],
    ['⌘/Ctrl A', 'Select all files'],
    ['Enter', 'Open the selected file'],
    ['F2', 'Rename the selected file'],
    ['⌘/Ctrl D', 'Download selection'],
    ['⌘/Ctrl ⇧ S', 'Share selection'],
    ['Delete / Backspace', 'Delete selection'],
    ['Esc', 'Close the active dialog or clear selection'],
    ['?', 'Show this shortcut reference'],
];

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(onClose, [onClose]);
    useModalFocus(panelRef, close);
    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="shortcut-title" tabIndex={-1} className="quiet-raised w-[min(520px,calc(100vw-2rem))] overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
                <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
                    <h2 id="shortcut-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><Command className="h-4 w-4 text-app-accent" />Keyboard shortcuts</h2>
                    <button onClick={onClose} className="quiet-control p-2 text-app-text-secondary hover:text-app-text" aria-label="Close shortcut reference"><X className="h-4 w-4" /></button>
                </header>
                <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 p-5">
                    {shortcuts.map(([keys, label]) => (
                        <div key={keys} className="contents">
                            <kbd className="my-1 justify-self-end rounded border border-app-border bg-app-surface-sunken px-2 py-1 font-mono text-xs text-app-text">{keys}</kbd>
                            <span className="my-1 self-center text-sm text-app-text-secondary">{label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
