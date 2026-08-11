import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Clock, Copy, ExternalLink, Globe2, KeyRound, Link, Loader2, MessageCircle, Server, Shield, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile, TelegramFolder, ShareInfo } from '../../../types';
import { nativeShareOrCopy } from '../../../utils';
import { useModalFocus } from '../../../hooks/useModalFocus';

interface ShareDialogProps {
    file: TelegramFile;
    folders?: TelegramFolder[];
    activeFolderId?: number | null;
    onClose: () => void;
    onOpenSettings?: () => void;
}

type ShareMode = 'telegram' | 'local' | 'power';

export function ShareDialog({ file, folders = [], activeFolderId = null, onClose, onOpenSettings }: ShareDialogProps) {
    const [mode, setMode] = useState<ShareMode | null>(null);
    const [password, setPassword] = useState('');
    const [expiryType, setExpiryType] = useState<'1h' | '1d' | '7d' | 'never'>('1d');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
    const [copied, setCopied] = useState(false);
    const [webDav, setWebDav] = useState<{ supported: boolean; enabled: boolean; running: boolean; port: number; token_set: boolean } | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const close = useCallback(onClose, [onClose]);
    useModalFocus(panelRef, close);

    const sourceFolderId = file.folder_id ?? activeFolderId;
    const sourceFolder = folders.find((folder) => folder.id === sourceFolderId);
    const telegramLink = sourceFolder?.username ? `https://t.me/${sourceFolder.username}/${file.id}` : null;

    useEffect(() => {
        if (mode !== 'power') return;
        invoke<{ supported: boolean; enabled: boolean; running: boolean; port: number; token_set: boolean }>('cmd_get_webdav_settings')
            .then(setWebDav)
            .catch(() => setWebDav(null));
    }, [mode]);

    const copy = async (value: string) => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
    };

    const generateLocalLink = async () => {
        if (password.trim().length < 4) {
            setError('Enter a password of at least 4 characters.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const expiryHours = expiryType === '1h' ? 1 : expiryType === '1d' ? 24 : expiryType === '7d' ? 168 : null;
            const result = await invoke<ShareInfo>('cmd_create_share', {
                folderId: sourceFolderId,
                messageId: file.id,
                fileName: file.name,
                fileSize: file.size,
                password: password.trim(),
                expiryHours,
            });
            setShareInfo(result);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setLoading(false);
        }
    };

    const renderModePicker = () => (
        <div className="space-y-3">
            <p className="text-sm text-app-text-secondary">Choose the kind of access you want to give.</p>
            <button disabled={!telegramLink} onClick={() => setMode('telegram')} className="quiet-surface flex w-full items-start gap-3 p-4 text-start hover:border-app-accent/40 hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-45">
                <MessageCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#2AABEE]" />
                <span><strong className="block text-sm text-app-text">Telegram link</strong><span className="mt-1 block text-xs leading-5 text-app-text-secondary">Direct link for Telegram users. Available when the source folder is a public channel.</span>{!telegramLink && <span className="mt-1 block text-xs text-app-warning">This folder is private, so it has no Telegram link.</span>}</span>
            </button>
            <button onClick={() => setMode('local')} className="quiet-surface flex w-full items-start gap-3 p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-app-success" />
                <span><strong className="block text-sm text-app-text">Local password link</strong><span className="mt-1 block text-xs leading-5 text-app-text-secondary">Create an expiring link protected by a password you choose.</span></span>
            </button>
            <button onClick={() => setMode('power')} className="quiet-surface flex w-full items-start gap-3 p-4 text-start hover:border-app-accent/40 hover:bg-app-hover">
                <Server className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" />
                <span><strong className="block text-sm text-app-text">WebDAV / REST</strong><span className="mt-1 block text-xs leading-5 text-app-text-secondary">Mount the drive or connect an automation using capability-token access.</span></span>
            </button>
        </div>
    );

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
            <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1} className="quiet-raised flex w-[min(480px,calc(100vw-2rem))] max-h-[85vh] flex-col overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
                <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
                    <div className="flex min-w-0 items-center gap-2">{mode && <button onClick={() => { setMode(null); setShareInfo(null); setError(null); }} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-text" aria-label="Back to sharing options"><ArrowLeft className="h-4 w-4" /></button>}<h2 id="share-title" className="truncate text-base font-semibold text-app-text">Share “{file.name}”</h2></div>
                    <button onClick={onClose} className="quiet-control p-2 text-app-text-secondary hover:text-app-text" aria-label="Close share dialog"><X className="h-4 w-4" /></button>
                </header>
                <div className="custom-scrollbar flex-1 overflow-y-auto p-5">
                    {!mode && renderModePicker()}

                    {mode === 'telegram' && telegramLink && (
                        <div className="space-y-4">
                            <div className="rounded-lg border border-[#2AABEE]/20 bg-[#2AABEE]/5 p-4"><MessageCircle className="mb-2 h-5 w-5 text-[#2AABEE]" /><h3 className="text-sm font-semibold text-app-text">Open in Telegram</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">Anyone who can access this public channel can open the message containing this file.</p></div>
                            <div className="flex gap-2"><input readOnly value={telegramLink} className="quiet-control min-w-0 flex-1 border border-app-border bg-app-surface-sunken px-3 text-sm text-app-text" /><button onClick={() => void copy(telegramLink)} className="quiet-control px-3 text-app-text hover:bg-app-hover" aria-label="Copy Telegram link">{copied ? <Check className="h-4 w-4 text-app-success" /> : <Copy className="h-4 w-4" />}</button></div>
                            {typeof navigator.share === 'function' && <button onClick={() => nativeShareOrCopy(file.name, file.sizeStr, telegramLink, () => void copy(telegramLink))} className="quiet-control flex w-full items-center justify-center gap-2 bg-[#2AABEE] px-4 py-2.5 text-sm font-medium text-white"><ExternalLink className="h-4 w-4" />Share with another app</button>}
                        </div>
                    )}

                    {mode === 'local' && (
                        <div className="space-y-4">
                            <div className="rounded-lg border border-app-success/20 bg-app-success/5 p-4"><Shield className="mb-2 h-5 w-5 text-app-success" /><h3 className="text-sm font-semibold text-app-text">Password-protected local link</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">The recipient needs network access to this computer and the password below.</p></div>
                            {!shareInfo ? <>
                                <label className="block text-sm font-medium text-app-text">Password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 4 characters" className="quiet-control mt-2 h-10 w-full border border-app-border bg-app-surface-sunken px-3 text-sm text-app-text outline-none focus:border-app-accent" /></label>
                                <div><span className="mb-2 flex items-center gap-2 text-sm font-medium text-app-text"><Clock className="h-4 w-4 text-app-warning" />Expires</span><div className="grid grid-cols-4 gap-2">{(['1h', '1d', '7d', 'never'] as const).map((value) => <button key={value} onClick={() => setExpiryType(value)} className={`quiet-control px-2 py-2 text-xs font-medium ${expiryType === value ? 'bg-app-selected text-app-accent' : 'text-app-text-secondary'}`}>{value === 'never' ? 'Never' : value}</button>)}</div></div>
                                {error && <div className="flex gap-2 rounded-lg border border-app-danger/20 bg-app-danger/5 p-3 text-xs text-app-danger"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
                                <button onClick={generateLocalLink} disabled={loading} className="quiet-control flex w-full items-center justify-center gap-2 bg-app-accent px-4 py-2.5 text-sm font-medium text-app-accent-contrast disabled:opacity-50">{loading && <Loader2 className="h-4 w-4 animate-spin" />}Create password link</button>
                            </> : <>
                                <div className="flex items-center gap-2 rounded-lg border border-app-success/20 bg-app-success/5 p-3 text-sm text-app-success"><Check className="h-4 w-4" />Link created</div>
                                <div className="flex gap-2"><input readOnly value={shareInfo.link} className="quiet-control min-w-0 flex-1 border border-app-border bg-app-surface-sunken px-3 text-sm text-app-text" /><button onClick={() => void copy(shareInfo.link)} className="quiet-control px-3 text-app-text" aria-label="Copy local link">{copied ? <Check className="h-4 w-4 text-app-success" /> : <Copy className="h-4 w-4" />}</button></div>
                            </>}
                        </div>
                    )}

                    {mode === 'power' && (
                        <div className="space-y-4">
                            <div className="rounded-lg border border-app-accent/20 bg-app-accent/5 p-4"><Globe2 className="mb-2 h-5 w-5 text-app-accent" /><h3 className="text-sm font-semibold text-app-text">Power-user connections</h3><p className="mt-1 text-xs leading-5 text-app-text-secondary">WebDAV works with Finder and file managers. REST works with scripts and automations. Both use private capability tokens—not SMB or Guest login.</p></div>
                            <div className="quiet-surface p-4"><div className="flex items-center justify-between"><span className="text-sm font-medium text-app-text">WebDAV</span><span className={`text-xs ${webDav?.running ? 'text-app-success' : 'text-app-text-tertiary'}`}>{webDav?.running ? `Running · port ${webDav.port}` : 'Not running'}</span></div><p className="mt-2 text-xs leading-5 text-app-text-secondary">Connect with the full generated <code>/dav/&lt;token&gt;/</code> URL. Guest access intentionally shows no files.</p></div>
                            <div className="quiet-surface p-4"><div className="flex items-center justify-between"><span className="text-sm font-medium text-app-text">REST API</span><span className="text-xs text-app-text-tertiary">Advanced</span></div><p className="mt-2 text-xs leading-5 text-app-text-secondary">Use a generated API key with the local REST endpoint for trusted integrations.</p></div>
                            {onOpenSettings && <button onClick={onOpenSettings} className="quiet-control flex w-full items-center justify-center gap-2 bg-app-accent px-4 py-2.5 text-sm font-medium text-app-accent-contrast"><Link className="h-4 w-4" />Open connection settings</button>}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
