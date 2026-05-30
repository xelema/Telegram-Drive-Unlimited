import { useState, useRef, useEffect } from 'react';
import { Pencil, X } from 'lucide-react';

interface RenameFolderModalProps {
    folderId: number;
    currentName: string;
    onRename: (folderId: number, oldName: string, newName: string) => Promise<void>;
    onClose: () => void;
}

export function RenameFolderModal({ folderId, currentName, onRename, onClose }: RenameFolderModalProps) {
    const [name, setName] = useState(currentName);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const handleSubmit = async () => {
        if (isSubmitting) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === currentName) {
            onClose();
            return;
        }
        setIsSubmitting(true);
        try {
            await onRename(folderId, currentName, trimmed);
            onClose();
        } catch {
            // error handled by parent
            setIsSubmitting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    return (
        <div
            className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-telegram-surface border border-telegram-border rounded-xl w-[360px] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-4 border-b border-telegram-border flex items-center justify-between">
                    <h3 className="text-telegram-text font-medium flex items-center gap-2">
                        <Pencil className="w-4 h-4 text-blue-400" />
                        Rename Folder
                    </h3>
                    <button
                        onClick={onClose}
                        className="text-telegram-subtext hover:text-telegram-text transition-colors"
                        disabled={isSubmitting}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-4 space-y-3">
                    <div className="text-sm text-telegram-subtext">
                        Enter a new name for <span className="text-telegram-text font-medium">"{currentName}"</span>
                    </div>
                    <input
                        ref={inputRef}
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        maxLength={100}
                        className="w-full bg-telegram-bg border border-telegram-border rounded-lg px-3 py-2 text-sm text-telegram-text placeholder:text-telegram-subtext/50 focus:outline-none focus:ring-2 focus:ring-telegram-primary/50 focus:border-telegram-primary/50 transition-all"
                        placeholder="Folder name"
                        disabled={isSubmitting}
                    />
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-telegram-border flex justify-end gap-2 bg-telegram-hover/10">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-telegram-subtext hover:text-telegram-text bg-telegram-hover/50 hover:bg-telegram-hover rounded-lg transition-colors"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !name.trim() || name.trim() === currentName}
                        className="px-4 py-2 text-sm font-medium text-white bg-telegram-primary hover:bg-telegram-primary/90 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
                    >
                        {isSubmitting ? 'Renaming...' : 'Rename'}
                    </button>
                </div>
            </div>
        </div>
    );
}
