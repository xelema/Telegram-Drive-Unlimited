import { useState, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';

interface RenameFolderSheetProps {
    folderId: number;
    currentName: string;
    onRename: (folderId: number, oldName: string, newName: string) => Promise<void>;
    onClose: () => void;
}

export function RenameFolderSheet({ folderId, currentName, onRename, onClose }: RenameFolderSheetProps) {
    const [name, setName] = useState(currentName);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // Small delay to let the slide-in animation start before focusing
        const timer = setTimeout(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        }, 200);
        return () => clearTimeout(timer);
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
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="w-full max-w-lg bg-telegram-surface border border-telegram-border/40 rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Drag handle */}
                <div className="flex justify-center mb-4">
                    <div className="w-10 h-1 rounded-full bg-telegram-border/60" />
                </div>

                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-xl bg-blue-400/10 text-blue-400">
                        <Pencil className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-telegram-text">Rename Folder</h3>
                        <p className="text-xs text-telegram-subtext mt-0.5">
                            Enter a new name for <span className="text-telegram-text font-medium">"{currentName}"</span>
                        </p>
                    </div>
                </div>

                {/* Input */}
                <input
                    ref={inputRef}
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={handleKeyDown}
                    maxLength={100}
                    className="w-full bg-telegram-bg border border-telegram-border rounded-xl px-3.5 py-3 text-sm text-telegram-text placeholder:text-telegram-subtext/50 focus:outline-none focus:ring-2 focus:ring-telegram-primary/50 focus:border-telegram-primary/50 transition-all mb-4"
                    placeholder="Folder name"
                    disabled={isSubmitting}
                />

                {/* Buttons */}
                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 text-sm font-semibold text-telegram-subtext hover:text-telegram-text bg-telegram-hover/30 hover:bg-telegram-hover/50 rounded-xl transition-colors active:scale-[0.98]"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !name.trim() || name.trim() === currentName}
                        className="flex-1 py-3 text-sm font-semibold text-white bg-telegram-primary hover:bg-telegram-primary/90 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-colors active:scale-[0.98]"
                    >
                        {isSubmitting ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                Renaming...
                            </span>
                        ) : (
                            'Rename'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
