import { FormEvent, useCallback, useRef, useState } from 'react';
import { FolderPlus, Info, X } from 'lucide-react';
import { useModalFocus } from '../../../hooks/useModalFocus';
import i18n from '../../../i18n';

interface CreateFolderDialogProps {
    onClose: () => void;
    onCreate: (name: string) => Promise<void>;
}

export function CreateFolderDialog({ onClose, onCreate }: CreateFolderDialogProps) {
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const panelRef = useRef<HTMLFormElement>(null);
    const close = useCallback(onClose, [onClose]);
    useModalFocus(panelRef, close);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const cleanName = name.trim();
        if (!cleanName || saving) return;
        setSaving(true);
        try {
            await onCreate(cleanName);
            onClose();
        } catch {
            // The caller reports the backend error and the dialog stays open for correction/retry.
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
            <form ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="create-folder-title" tabIndex={-1} onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} className="quiet-raised w-[min(440px,calc(100vw-2rem))] overflow-hidden">
                <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
                    <h2 id="create-folder-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><FolderPlus className="h-4 w-4 text-app-accent" />Create a folder</h2>
                    <button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary hover:text-app-text" aria-label={i18n.t("common.close")}><X className="h-4 w-4" /></button>
                </header>
                <div className="space-y-4 p-5">
                    <label className="block text-sm font-medium text-app-text">
                        {i18n.t("files.folder_name")}
                        <input autoFocus data-modal-autofocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="e.g. Project files" className="quiet-control mt-2 h-10 w-full border border-app-border bg-app-surface-sunken px-3 text-sm text-app-text outline-none focus:border-app-accent" />
                    </label>
                    <div className="flex gap-3 rounded-lg border border-app-border-subtle bg-app-surface-sunken/30 p-3 text-xs leading-5 text-app-text-secondary">
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-app-accent" />
                        <span>This creates a private Telegram channel that Telegram Drive presents as a folder. Its files remain in your Telegram account.</span>
                    </div>
                </div>
                <footer className="flex justify-end gap-3 border-t border-app-border-subtle px-5 py-4">
                    <button type="button" onClick={onClose} className="quiet-control px-4 py-2.5 text-sm font-medium text-app-text-secondary hover:text-app-text">{i18n.t("common.cancel")}</button>
                    <button type="submit" disabled={!name.trim() || saving} className="quiet-control bg-app-accent px-4 py-2.5 text-sm font-medium text-app-accent-contrast hover:bg-app-accent-hover disabled:opacity-50">{saving ? 'Creating…' : 'Create private folder'}</button>
                </footer>
            </form>
        </div>
    );
}
