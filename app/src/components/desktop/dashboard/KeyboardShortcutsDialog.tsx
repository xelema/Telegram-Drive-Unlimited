import {useTranslation} from 'react-i18next';
import i18n from '../../../i18n';
import { useCallback, useRef } from 'react';
import { Command, X } from 'lucide-react';
import { useModalFocus } from '../../../hooks/useModalFocus';

const shortcuts = [
    { keys: '⌘/Ctrl F', labelKey: 'shortcut_labels.search' },
    { keys: '⌘/Ctrl A', labelKey: 'shortcut_labels.select_all' },
    { keys: 'Enter', labelKey: 'shortcut_labels.open' },
    { keys: 'F2', labelKey: 'shortcut_labels.rename' },
    { keys: '⌘/Ctrl D', labelKey: 'shortcut_labels.download' },
    { keys: '⌘/Ctrl ⇧ S', labelKey: 'shortcut_labels.share' },
    { keys: 'Delete / Backspace', labelKey: 'shortcut_labels.delete' },
    { keys: 'Esc', labelKey: 'shortcut_labels.close' },
    { keys: '?', labelKey: 'shortcut_labels.show' },
];

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(onClose, [onClose]);
    useModalFocus(panelRef, close);
    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="shortcut-title" tabIndex={-1} className="quiet-raised w-[min(520px,calc(100vw-2rem))] overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
                <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
                    <h2 id="shortcut-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><Command className="h-4 w-4 text-app-accent" />{i18n.t('ui_copy.keyboard_shortcuts')}</h2>
                    <button onClick={onClose} className="quiet-control p-2 text-app-text-secondary hover:text-app-text" aria-label={i18n.t('ui_copy.close_shortcuts')}><X className="h-4 w-4" /></button>
                </header>
                <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 p-5">
                    {shortcuts.map(({ keys, labelKey }) => (
                        <div key={keys} className="contents">
                            <kbd className="my-1 justify-self-end rounded border border-app-border bg-app-surface-sunken px-2 py-1 font-mono text-xs text-app-text">{keys}</kbd>
                            <span className="my-1 self-center text-sm text-app-text-secondary">{t(labelKey)}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
