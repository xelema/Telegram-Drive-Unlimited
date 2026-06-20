import React, { useState } from 'react';
import { X, Globe, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TelegramFolder } from '../../../types';
import { toast } from 'sonner';

interface RemoteUploadModalProps {
    isOpen: boolean;
    onClose: () => void;
    folders: TelegramFolder[];
    onUpload: (url: string, folderId: number | null) => void;
}

export function RemoteUploadModal({ isOpen, onClose, folders, onUpload }: RemoteUploadModalProps) {
    const [url, setUrl] = useState('');
    const [folderId, setFolderId] = useState<number | null>(null);
    const { t } = useTranslation();

    if (!isOpen) return null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!url.trim()) {
            toast.error(t('files.please_enter_url'));
            return;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            toast.error(t('files.url_must_start'));
            return;
        }
        onUpload(url.trim(), folderId);
        setUrl('');
        setFolderId(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <form
                onSubmit={handleSubmit}
                className="bg-telegram-surface border border-telegram-border rounded-xl w-[420px] shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
                onClick={e => e.stopPropagation()}
            >
                <div className="p-4 border-b border-telegram-border flex items-center justify-between">
                    <h3 className="text-telegram-text font-medium flex items-center gap-2">
                        <Globe className="w-5 h-5 text-telegram-primary" />
                        {t('files.remote_upload_url')}
                    </h3>
                    <button type="button" onClick={onClose} className="text-telegram-subtext hover:text-telegram-text transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div className="space-y-1">
                        <label className="text-xs text-telegram-subtext font-medium">{t('files.remote_file_url')}</label>
                        <input
                            type="text"
                            placeholder="https://example.com/file.zip"
                            value={url}
                            onChange={e => setUrl(e.target.value)}
                            className="w-full bg-telegram-bg border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text placeholder:text-telegram-subtext/60 focus:outline-none focus:border-telegram-primary/50 transition-colors"
                            autoFocus
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs text-telegram-subtext font-medium">{t('files.destination_folder')}</label>
                        <div className="relative">
                            <select
                                value={folderId === null ? '' : folderId}
                                onChange={e => setFolderId(e.target.value === '' ? null : Number(e.target.value))}
                                className="appearance-none w-full bg-telegram-bg border border-telegram-border rounded-md pl-3 pr-8 py-1.5 text-sm text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                            >
                                <option value="">{t('common.saved_messages')}</option>
                                {folders.map(folder => (
                                    <option key={folder.id} value={folder.id}>
                                        {folder.name}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="w-4 h-4 text-telegram-subtext absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-telegram-border bg-telegram-hover/20 flex gap-3 justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg border border-telegram-border hover:bg-telegram-hover text-telegram-text text-sm font-medium transition-all"
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type="submit"
                        className="px-4 py-2 rounded-lg bg-telegram-primary hover:bg-telegram-primary/95 text-white text-sm font-medium transition-all shadow-md"
                    >
                        {t('files.start_upload')}
                    </button>
                </div>
            </form>
        </div>
    );
}
