import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, CheckCircle2 } from 'lucide-react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DragDropOverlay } from './DragDropOverlay';

/**
 * ExternalDropBlocker - Intercepts external file drops and triggers uploads directly.
 * 
 * With Tauri's dragDropEnabled: false, we handle DOM drag events ourselves.
 * On drop, file paths are extracted from File objects (Tauri webviews expose .path)
 * and passed to the onFilesDropped callback for direct upload queueing.
 * 
 * Falls back to showing the Upload dialog prompt only if file paths cannot be extracted.
 */
export function ExternalDropBlocker({ onFilesDropped, onUploadClick }: { onFilesDropped?: (paths: string[]) => void; onUploadClick?: () => void }) {
    const [isDragging, setIsDragging] = useState(false);
    const [droppedCount, setDroppedCount] = useState<number | null>(null);
    const [showFallback, setShowFallback] = useState(false);
    
    // Use refs for values accessed inside stable event listeners
    const onFilesDroppedRef = useRef(onFilesDropped);
    onFilesDroppedRef.current = onFilesDropped;

    // Listen for file-dropped events emitted from Rust on_navigation handler.
    // This catches file drops on Linux window managers that bypass DOM drag events
    // and instead pass files as application-level file-open events.
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        let messageTimeout: ReturnType<typeof setTimeout>;

        (async () => {
            try {
                unlisten = await listen<string>('file-dropped', (event) => {
                    const path = event.payload;
                    if (path && typeof path === 'string' && path.length > 0) {
                        onFilesDroppedRef.current?.([path]);
                        // Show the same visual confirmation as DOM-based drops
                        clearTimeout(messageTimeout);
                        setDroppedCount(1);
                        messageTimeout = setTimeout(() => setDroppedCount(null), 2000);
                    }
                });
            } catch (e) {
                // listen() throws only if the event name is invalid — shouldn't happen
                console.warn('[ExternalDropBlocker] Failed to listen for file-dropped event:', e);
            }
        })();

        return () => {
            if (unlisten) unlisten();
            clearTimeout(messageTimeout);
        };
    }, []);

    useEffect(() => {
        let dragEnterCount = 0;
        let hideTimeout: ReturnType<typeof setTimeout>;
        let messageTimeout: ReturnType<typeof setTimeout>;

        const handleDragEnter = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                dragEnterCount++;
                setIsDragging(true);
                clearTimeout(hideTimeout);
            }
        };

        const handleDragOver = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                clearTimeout(hideTimeout);
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                dragEnterCount--;
                // Only hide when truly leaving the window
                if (dragEnterCount <= 0 &&
                    (e.clientX <= 0 || e.clientY <= 0 ||
                     e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
                    dragEnterCount = 0;
                    hideTimeout = setTimeout(() => {
                        setIsDragging(false);
                    }, 150);
                }
            }
        };

        const handleDrop = (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes('Files')) return;

            e.preventDefault();
            e.stopPropagation();
            dragEnterCount = 0;
            setIsDragging(false);
            clearTimeout(hideTimeout);
            clearTimeout(messageTimeout);

            const files = e.dataTransfer.files;
            const paths: string[] = [];

            for (let i = 0; i < files.length; i++) {
                // In Tauri webviews, File objects expose a non-standard .path property
                const path = (files[i] as any).path as string | undefined;
                if (path && typeof path === 'string' && path.length > 0) {
                    paths.push(path);
                }
            }

            if (paths.length > 0 && onFilesDroppedRef.current) {
                onFilesDroppedRef.current(paths);
                setDroppedCount(paths.length);
                messageTimeout = setTimeout(() => setDroppedCount(null), 2000);
            } else {
                // Fallback: file paths not available (e.g., non-Tauri browser during dev)
                setShowFallback(true);
                messageTimeout = setTimeout(() => setShowFallback(false), 4000);
            }
        };

        // Capture phase ensures we intercept before the webview's default handler
        document.addEventListener('dragenter', handleDragEnter, true);
        document.addEventListener('dragover', handleDragOver, true);
        document.addEventListener('dragleave', handleDragLeave, true);
        document.addEventListener('drop', handleDrop, true);

        return () => {
            document.removeEventListener('dragenter', handleDragEnter, true);
            document.removeEventListener('dragover', handleDragOver, true);
            document.removeEventListener('dragleave', handleDragLeave, true);
            document.removeEventListener('drop', handleDrop, true);
            clearTimeout(hideTimeout);
            clearTimeout(messageTimeout);
        };
    }, []);

    return (
        <>
            {/* Drag overlay - shown while files are being dragged over the window */}
            <AnimatePresence>
                {isDragging && <DragDropOverlay />}
            </AnimatePresence>

            {/* Brief success confirmation after drop */}
            <AnimatePresence>
                {droppedCount !== null && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="fixed bottom-20 right-4 z-[110] pointer-events-none"
                    >
                        <div className="glass bg-telegram-surface border border-green-500/30 rounded-xl p-4 flex items-center gap-3 shadow-xl">
                            <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                            <span className="text-sm text-telegram-text">
                                Queued {droppedCount} file{droppedCount !== 1 ? 's' : ''} for upload
                            </span>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Fallback message when file paths cannot be extracted */}
            <AnimatePresence>
                {showFallback && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-none"
                    >
                        <div className="glass bg-telegram-surface border border-telegram-border rounded-2xl p-8 max-w-md mx-4 shadow-2xl pointer-events-auto">
                            <div className="flex flex-col items-center text-center gap-4">
                                <div className="w-16 h-16 rounded-full bg-telegram-primary/20 flex items-center justify-center">
                                    <Upload className="w-8 h-8 text-telegram-primary" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold text-telegram-text mb-2">
                                        Drag-and-drop not available
                                    </h3>
                                    <p className="text-telegram-subtext text-sm">
                                        File paths could not be read from the drag event.
                                        <br />
                                        Use the button below or the <strong>Upload File</strong> button in the toolbar.
                                    </p>
                                </div>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setShowFallback(false)}
                                        className="mt-2 px-4 py-2 bg-telegram-hover text-telegram-text rounded-lg text-sm hover:bg-telegram-border transition-colors"
                                    >
                                        Dismiss
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowFallback(false);
                                            onUploadClick?.();
                                        }}
                                        className="mt-2 px-6 py-2 bg-telegram-primary text-white rounded-lg font-medium hover:bg-telegram-primary/90 transition-colors"
                                    >
                                        Open Upload Dialog
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
