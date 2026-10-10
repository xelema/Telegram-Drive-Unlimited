import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { ConfirmOptions, SecretPromptOptions } from '../../context/ConfirmContext';
import type { DownloadCollisionPolicy } from '../../types/transfers';

interface Props {
    isOpen: boolean;
    collisionOpen: boolean;
    options: ConfirmOptions;
    onConfirm: () => void;
    onCancel: () => void;
    onCollision: (policy: DownloadCollisionPolicy | null) => void;
    secretOptions: SecretPromptOptions | null;
    onSecret: (value: string | null) => void;
}

/** Masked passphrase entry. State lives only while the dialog is open. */
function SecretPromptDialog({ options, onSecret }: { options: SecretPromptOptions; onSecret: (value: string | null) => void }) {
    const { t } = useTranslation();
    const panelRef = useRef<HTMLFormElement>(null);
    const [secret, setSecret] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    useModalFocus(panelRef, () => onSecret(null));
    // Drop the typed value as soon as the dialog goes away.
    useEffect(() => () => { setSecret(''); setConfirmation(''); }, []);
    const minBytes = options.minBytes ?? 1;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (new TextEncoder().encode(secret).length < minBytes) {
            setProblem(t('settings.min_passphrase_length'));
            return;
        }
        if (options.confirmEntry && confirmation !== secret) {
            setProblem(t('settings.passphrases_no_match'));
            return;
        }
        onSecret(secret);
    };
    const field = 'w-full rounded-lg border border-telegram-border bg-telegram-bg px-3 py-2 text-sm text-telegram-text outline-none focus:border-telegram-primary';
    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
            <form ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="secret-prompt-title" aria-describedby={options.message ? 'secret-prompt-message' : undefined}
                tabIndex={-1} onSubmit={submit} className="w-full max-w-sm rounded-xl border border-telegram-border bg-telegram-surface p-6 shadow-2xl">
                <h3 id="secret-prompt-title" className="text-lg font-medium text-telegram-text">{options.title}</h3>
                {options.message && <p id="secret-prompt-message" className="mt-2 whitespace-pre-line text-sm text-telegram-subtext">{options.message}</p>}
                <input type="password" data-modal-autofocus autoComplete="off" spellCheck={false} aria-labelledby="secret-prompt-title"
                    value={secret} onChange={event => { setSecret(event.target.value); setProblem(null); }} className={`${field} mt-4`} />
                {options.confirmEntry && <input type="password" autoComplete="off" spellCheck={false} aria-label={t('settings.confirm_passphrase')} placeholder={t('settings.confirm_passphrase')}
                    value={confirmation} onChange={event => { setConfirmation(event.target.value); setProblem(null); }} className={`${field} mt-3`} />}
                {problem && <p role="alert" className="mt-3 text-sm text-red-400">{problem}</p>}
                <div className="mt-6 flex justify-end gap-3">
                    <button type="button" onClick={() => onSecret(null)} className="min-h-11 rounded-lg px-4 text-sm text-telegram-subtext">{t('common.cancel')}</button>
                    <button type="submit" disabled={!secret} className="min-h-11 rounded-lg bg-telegram-primary px-4 text-sm font-medium text-white disabled:opacity-50">{options.confirmText || t('common.confirm')}</button>
                </div>
            </form>
        </div>
    );
}

/** Loaded when an operation needs a decision, keeping dialogs out of startup. */
export default function ConfirmationDialogs({ isOpen, collisionOpen, options, onConfirm, onCancel, onCollision, secretOptions, onSecret }: Props) {
    const { t } = useTranslation();
    const panelRef = useRef<HTMLDivElement>(null);
    const collisionPanel = useRef<HTMLDivElement>(null);
    const [collisionPolicy, setCollisionPolicy] = useState<DownloadCollisionPolicy>('keep_both');
    useModalFocus(panelRef, onCancel, isOpen);
    useModalFocus(collisionPanel, () => onCollision(null), collisionOpen);
    return <>
            {secretOptions && <SecretPromptDialog options={secretOptions} onSecret={onSecret} />}
            {collisionOpen && <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
                <div ref={collisionPanel} role="dialog" aria-modal="true" aria-labelledby="download-collision-title" tabIndex={-1} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-telegram-border bg-telegram-surface p-6 shadow-2xl">
                    <h3 id="download-collision-title" className="text-lg font-medium">{t('downloadCollision.title')}</h3>
                    <p className="mt-2 text-sm text-telegram-subtext">{t('downloadCollision.description')}</p>
                    <fieldset className="my-4 space-y-2">
                        <legend className="sr-only">{t('downloadCollision.title')}</legend>
                        {(['keep_both', 'skip', 'replace'] as const).map(policy => <label key={policy} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-telegram-border p-3">
                            <input type="radio" name="download-collision" value={policy} checked={collisionPolicy === policy} onChange={() => setCollisionPolicy(policy)} className="mt-1" />
                            <span><span className="block text-sm font-medium">{t(`downloadCollision.${policy}`)}</span><span className="mt-1 block text-xs leading-relaxed text-telegram-subtext">{t(`downloadCollision.${policy}_description`)}</span></span>
                        </label>)}
                    </fieldset>
                    <div className="flex justify-end gap-3"><button type="button" onClick={() => onCollision(null)} className="min-h-11 rounded-lg px-4 text-sm text-telegram-subtext">{t('common.cancel')}</button><button type="button" onClick={() => onCollision(collisionPolicy)} className={`min-h-11 rounded-lg px-4 text-sm font-medium ${collisionPolicy === 'replace' ? 'bg-red-500/15 text-red-400' : 'bg-telegram-primary text-white'}`}>{t(collisionPolicy === 'replace' ? 'downloadCollision.replace_confirm' : 'downloadCollision.continue')}</button></div>
                </div>
            </div>}
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" tabIndex={-1} className="bg-[#1c1c1c] border border-white/10 rounded-xl p-6 w-96 shadow-2xl animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
                        <h3 id="confirm-dialog-title" className="text-lg font-medium text-white mb-2">{options.title}</h3>
                        <p className="text-telegram-subtext text-sm mb-6 whitespace-pre-line">{options.message}</p>
                        <div className="flex justify-end gap-3">
                            <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-white/5 text-telegram-subtext transition">
                                {options.cancelText || t('common.cancel')}
                            </button>
                            <button
                                onClick={onConfirm}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${options.variant === 'danger' ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-telegram-primary text-white hover:bg-telegram-primary/90'}`}
                            >
                                {options.confirmText || t('common.confirm')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
    </>;
}
