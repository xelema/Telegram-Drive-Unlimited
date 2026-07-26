import { useEffect, useState, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
// Use the legacy build — the modern build uses Map.getOrInsertComputed()
// which isn't available in Tauri's WebKit WebView
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TelegramFile } from '../../../types';
import { isAndroidPlatform } from '../../../utils';

// Use Vite's ?url suffix to get a properly bundled asset URL for the worker
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface StreamInfo {
    token: string;
    base_url: string;
}

interface PdfViewerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
}

export function PdfViewer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId }: PdfViewerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
    const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [numPages, setNumPages] = useState<number>(0);
    const [scale, setScale] = useState<number>(1.2);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [openingExternal, setOpeningExternal] = useState<boolean>(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

    const handleOpenExternally = async (e: React.MouseEvent) => {
        e.stopPropagation();
        setOpeningExternal(true);
        try {
            const path = await invoke<string>('cmd_get_preview', {
                messageId: file.id,
                folderId: activeFolderId
            });
            if (path) {
                await invoke('cmd_open_file_externally', { path });
            } else {
                alert("Failed to locate file path.");
            }
        } catch (err) {
            console.error("Failed to open externally:", err);
            alert("Error: " + String(err));
        } finally {
            setOpeningExternal(false);
        }
    };

    // Fetch stream info once
    useEffect(() => {
        if (isAndroidPlatform) return; // skip on Android
        invoke<StreamInfo>('cmd_get_stream_info').then(setStreamInfo).catch((err) => {
            console.error("Failed to get stream info:", err);
            setError("Failed to initialize stream");
        });
    }, []);

    // Load PDF document when stream URL is ready or file changes
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setPdf(null);
        setNumPages(0);

        if (isAndroidPlatform) {
            let activeLoadingTask: any = null;
            // Android: load via converted cache file URL
            invoke<string>('cmd_get_preview', {
                messageId: file.id,
                folderId: activeFolderId
            }).then((filePath) => {
                if (cancelled) return;
                if (filePath) {
                    const url = convertFileSrc(filePath);
                    const loadingTask = pdfjsLib.getDocument({
                        url: url,
                        disableRange: true,
                        disableStream: true,
                        disableAutoFetch: true,
                    });
                    activeLoadingTask = loadingTask;
                    loadingTask.promise.then(
                        (pdfDoc) => {
                            if (cancelled) {
                                pdfDoc.destroy();
                                return;
                            }
                            if (pdfRef.current) {
                                pdfRef.current.destroy();
                            }
                            pdfRef.current = pdfDoc;
                            setPdf(pdfDoc);
                            setNumPages(pdfDoc.numPages);
                            setLoading(false);
                        },
                        (err) => {
                            if (cancelled) return;
                            console.error("Error loading PDF via cache URL, falling back to external opener:", err);
                            invoke('cmd_open_file_externally', { path: filePath })
                                .then(() => {
                                    if (!cancelled) onClose();
                                })
                                .catch((exErr) => {
                                    if (!cancelled) {
                                        setError("Failed to render PDF in WebView or open natively: " + String(exErr));
                                        setLoading(false);
                                    }
                                });
                        }
                    );
                } else {
                    setError("Failed to fetch PDF preview path.");
                    setLoading(false);
                }
            }).catch((err) => {
                if (cancelled) return;
                console.error("Error invoking PDF preview command:", err);
                setError("Failed to load PDF.");
                setLoading(false);
            });

            return () => {
                cancelled = true;
                if (activeLoadingTask) {
                    activeLoadingTask.destroy();
                }
                if (pdfRef.current) {
                    pdfRef.current.destroy();
                }
            };
        }

        // Desktop: stream via Actix local server
        if (!streamInfo) return;

        const folderIdParam = activeFolderId !== null ? activeFolderId.toString() : 'home';
        const streamUrl = `${streamInfo.base_url}/stream/${folderIdParam}/${file.id}?token=${streamInfo.token}`;

        const loadingTask = pdfjsLib.getDocument(streamUrl);

        loadingTask.promise.then(
             (pdfDoc) => {
                 if (cancelled) {
                     pdfDoc.destroy();
                     return;
                 }
                 // Destroy previous document if any
                 if (pdfRef.current) {
                     pdfRef.current.destroy();
                 }
                 pdfRef.current = pdfDoc;
                 setPdf(pdfDoc);
                 setNumPages(pdfDoc.numPages);
                 setLoading(false);
             },
             (err) => {
                 if (cancelled) return;
                 console.error("Error loading PDF:", err);
                 setError("Failed to load PDF document.");
                 setLoading(false);
             }
        );

        return () => {
            cancelled = true;
            loadingTask.destroy();
        };
    }, [streamInfo, activeFolderId, file.id]);

    // Cleanup PDF document on unmount
    useEffect(() => {
        return () => {
            if (pdfRef.current) {
                pdfRef.current.destroy();
                pdfRef.current = null;
            }
        };
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }

            const key = e.key.toLowerCase();

            if (e.key === 'ArrowRight' || key === 'l') {
                e.preventDefault();
                onNext?.();
                return;
            }

            if (e.key === 'ArrowLeft' || key === 'j') {
                e.preventDefault();
                onPrev?.();
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
                return;
            }

            if (e.key === '=' || key === '+') {
                e.preventDefault();
                setScale(s => Math.min(s + 0.2, 3));
            }

            if (e.key === '-') {
                e.preventDefault();
                setScale(s => Math.max(s - 0.2, 0.5));
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, onNext, onPrev]);

    const handleZoomIn = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(s => Math.min(s + 0.2, 3));
    };

    const handleZoomOut = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(s => Math.max(s - 0.2, 0.5));
    };

    const handleFitWidth = (e: React.MouseEvent) => {
        e.stopPropagation();
        setScale(1.2);
    };

    return (
        <div className="viewer-overlay fixed inset-0 z-[200] flex flex-col p-4 animate-in fade-in duration-150" onClick={onClose}>
            {/* Header / Controls */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-between px-4 pt-[calc(1rem+env(safe-area-inset-top))] md:px-6">
                <div className="viewer-toolbar pointer-events-auto px-2">
                    <h3 className="max-w-[120px] truncate px-1 text-metadata font-medium text-white sm:max-w-xs" title={file.name}>{file.name}</h3>
                    <button
                        onClick={handleOpenExternally}
                        disabled={openingExternal}
                        className="quiet-control h-7 rounded-control bg-app-accent px-2 text-badge font-semibold text-app-accent-contrast disabled:opacity-50"
                        title="Open document in a native external app"
                    >
                        {openingExternal ? 'Opening...' : 'Open Natively'}
                    </button>
                </div>

                <div className="pointer-events-auto flex items-center gap-2">
                    <div className="viewer-toolbar">
                        <button onClick={handleZoomOut} className="viewer-control" title="Zoom Out (-)" aria-label="Zoom out">
                            <ZoomOut className="w-4 h-4" />
                        </button>
                        <span className="min-w-[3rem] text-center text-badge font-medium tabular-nums text-white/85">{Math.round(scale * 100)}%</span>
                        <button onClick={handleZoomIn} className="viewer-control" title="Zoom In (+)" aria-label="Zoom in">
                            <ZoomIn className="w-4 h-4" />
                        </button>
                        <div className="mx-0.5 h-4 w-px bg-white/15"></div>
                        <button onClick={handleFitWidth} className="viewer-control" title="Fit Width" aria-label="Fit width">
                            <Maximize className="w-4 h-4" />
                        </button>
                    </div>

                    <button
                        onClick={onClose}
                        className="viewer-navigation"
                        title="Close PDF Viewer"
                        aria-label="Close PDF"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {/* Navigation Buttons */}
            <button
                onClick={(e) => { e.stopPropagation(); onPrev?.(); }}
                className="viewer-navigation absolute start-4 top-1/2 z-10 -translate-y-1/2"
                title="Previous file (ArrowLeft / J)"
                aria-label="Previous file"
            >
                <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
            </button>

            <button
                onClick={(e) => { e.stopPropagation(); onNext?.(); }}
                className="viewer-navigation absolute end-4 top-1/2 z-10 -translate-y-1/2"
                title="Next file (ArrowRight / L)"
                aria-label="Next file"
            >
                <ChevronRight className="h-5 w-5 rtl:rotate-180" />
            </button>

            {/* Scrollable Document Container */}
            <div
                ref={containerRef}
                className="flex-1 w-full overflow-auto custom-scrollbar flex flex-col items-center pt-[calc(5rem+env(safe-area-inset-top))] pb-24 relative"
                onClick={(e) => e.stopPropagation()}
            >
                {loading && (
                    <div className="absolute inset-0 flex flex-1 flex-col items-center justify-center text-white">
                        <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-app-accent"></div>
                        <p className="text-ui font-medium">Loading document…</p>
                        <p className="mt-1 text-badge text-white/45">Downloading from Telegram…</p>
                    </div>
                )}

                {error && (
                    <div className="viewer-panel mt-20 flex max-w-md flex-col items-center justify-center border-app-danger/30 bg-app-danger/10 p-5 text-center text-white">
                        <p className="mb-1 text-ui font-semibold text-app-danger">Unable to open PDF</p>
                        <p className="mb-5 text-metadata leading-relaxed text-white/60">{error}</p>
                        <button
                            onClick={handleOpenExternally}
                            disabled={openingExternal}
                            className="quiet-control pointer-events-auto h-9 rounded-control bg-app-accent px-4 text-ui font-semibold text-app-accent-contrast disabled:opacity-50"
                        >
                            {openingExternal ? 'Opening...' : 'Open with External App'}
                        </button>
                    </div>
                )}

                {pdf && numPages > 0 && (
                    <div className="flex flex-col gap-4 w-full items-center">
                        {Array.from({ length: numPages }, (_, index) => (
                            <PdfPage
                                key={`${file.id}_page_${index + 1}`}
                                pageNumber={index + 1}
                                pdf={pdf}
                                scale={scale}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Footer Navigation Info */}
            <div className="viewer-toolbar pointer-events-none absolute bottom-4 start-1/2 -translate-x-1/2 px-3 py-1.5 text-metadata text-white/50 rtl:translate-x-1/2">
                {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                    <span className="me-3 border-e border-white/20 pe-3">File {currentIndex + 1} of {totalItems}</span>
                )}
                <span>{numPages} {numPages === 1 ? 'page' : 'pages'}</span>
            </div>
        </div>
    );
}

// Individual Page Component — lazy-loaded via IntersectionObserver
function PdfPage({ pageNumber, pdf, scale }: { pageNumber: number; pdf: pdfjsLib.PDFDocumentProxy; scale: number }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy['render']> | null>(null);
    const [isVisible, setIsVisible] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [page, setPage] = useState<pdfjsLib.PDFPageProxy | null>(null);

    // Intersection Observer — load page data when within 1000px of viewport
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const observer = new IntersectionObserver(
            (entries) => {
                setIsVisible(entries[0].isIntersecting);
            },
            { rootMargin: '1000px 0px' }
        );

        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // Clear/unload canvas and page structure when not visible to release memory
    useEffect(() => {
        if (!isVisible) {
            setPage(null);
            if (canvasRef.current) {
                const canvas = canvasRef.current;
                canvas.width = 0;
                canvas.height = 0;
            }
        }
    }, [isVisible]);

    // Fetch the PDF page object when visible
    useEffect(() => {
        if (!isVisible || !pdf) return;

        let cancelled = false;
        pdf.getPage(pageNumber).then(loadedPage => {
            if (!cancelled) {
                setPage(loadedPage);
            }
        }).catch(err => console.error(`Error loading page ${pageNumber}:`, err));

        return () => {
            cancelled = true;
        };
    }, [isVisible, pdf, pageNumber]);

    // Render the page to canvas — re-runs when page loads or scale changes
    useEffect(() => {
        if (!page || !canvasRef.current || !isVisible) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');

        if (!context) return;

        // Cancel any in-flight render before starting a new one
        if (renderTaskRef.current) {
            renderTaskRef.current.cancel();
            renderTaskRef.current = null;
        }

        // Size canvas and clear before render to avoid stale frame flash
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        context.clearRect(0, 0, viewport.width, viewport.height);

        const renderTask = page.render({
            canvasContext: context,
            viewport: viewport,
            canvas: canvas,
        });
        renderTaskRef.current = renderTask;

        renderTask.promise.catch((err) => {
            // RenderingCancelledException is expected during zoom — ignore it
            if (err?.name !== 'RenderingCancelledException') {
                console.error(`Render error on page ${pageNumber}:`, err);
            }
        });

        return () => {
            renderTask.cancel();
            renderTaskRef.current = null;
        };
    }, [page, scale, isVisible, pageNumber]);

    // Estimated dimensions for the placeholder before page loads (US Letter @ 96 DPI)
    const estimatedHeight = 1056 * scale;
    const estimatedWidth = 816 * scale;

    return (
        <div
            ref={containerRef}
            className="relative my-2 flex flex-col items-center overflow-hidden rounded-control bg-white/5 shadow-[0_8px_28px_rgba(0,0,0,0.32)]"
            style={{
                minHeight: !page ? `${estimatedHeight}px` : undefined,
                minWidth: !page ? `${estimatedWidth}px` : undefined,
            }}
        >
            <canvas ref={canvasRef} className="max-w-full h-auto bg-white" />

            {!page && isVisible && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-white/30">
                    <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin"></div>
                </div>
            )}
        </div>
    );
}
