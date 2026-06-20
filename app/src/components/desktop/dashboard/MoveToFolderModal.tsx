import { Plus, HardDrive, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TelegramFolder } from '../../../types';

interface MoveToFolderModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onSelect: (id: number | null) => void;
    activeFolderId: number | null;
    fileName?: string;
}

export function MoveToFolderModal({ folders, onClose, onSelect, activeFolderId, fileName }: MoveToFolderModalProps) {
    const { t } = useTranslation();

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-telegram-surface border border-telegram-border rounded-xl w-80 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-telegram-border flex justify-between items-center">
                    <h3 className="text-telegram-text font-medium truncate max-w-[220px]">
                        {fileName ? t('files.move_file_to_folder', { name: fileName }) : t('files.move_to_folder')}
                    </h3>
                    <button onClick={onClose} className="text-telegram-subtext hover:text-telegram-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {activeFolderId !== null && (
                        <button
                            onClick={() => onSelect(null)}
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-telegram-text hover:bg-telegram-hover transition-colors"
                        >
                            <div className="w-8 h-8 rounded bg-telegram-primary/20 flex items-center justify-center text-telegram-primary">
                                <HardDrive className="w-4 h-4" />
                            </div>
                            <span className="font-medium">{t('common.saved_messages')}</span>
                        </button>
                    )}

                    {folders.map((f: any) => {
                        if (f.id === activeFolderId) return null;
                        return (
                            <button
                                key={f.id}
                                onClick={() => onSelect(f.id)}
                                className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-telegram-text hover:bg-telegram-hover transition-colors"
                            >
                                <div className="w-8 h-8 rounded bg-telegram-hover flex items-center justify-center text-telegram-text">
                                    <Folder className="w-4 h-4" />
                                </div>
                                <span className="font-medium">{f.name}</span>
                            </button>
                        )
                    })}

                    {folders.length === 0 && activeFolderId === null && (
                        <div className="p-4 text-center text-xs text-telegram-subtext">{t('files.no_other_folders')}</div>
                    )}
                </div>
            </div>
        </div>
    )
}
