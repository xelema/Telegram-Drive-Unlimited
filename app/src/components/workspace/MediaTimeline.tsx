import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Image, Play, Star, FolderOpen, Check, MoreHorizontal } from 'lucide-react';
import { groupTimeline, type WorkspaceFile } from '../../services/workspace';
import { formatBytes, isImageFile, isVideoFile } from '../../utils';
import { FileTypeIcon } from '../shared/FileTypeIcon';

export function WorkspaceThumbnail({ ownerId, file }: { ownerId: string; file: WorkspaceFile }) {
    const target = useRef<HTMLDivElement>(null);
    const identity = `${ownerId}:${file.key}`;
    const [asset, setAsset] = useState<{ identity: string; source: string } | null>(null);
    useEffect(() => {
        let active = true; let requested = false; let settled = false;
        const requestId = crypto.randomUUID();
        setAsset(null);
        const request = () => {
            if (requested || file.encryption_state && file.encryption_state !== 'plain') return;
            requested = true;
            void invoke<string>('cmd_workspace_asset', { ownerId, key: file.key, thumbnail: true, requestId })
                .then(path => { if (active && path) setAsset({ identity, source: convertFileSrc(path) }); })
                .catch(() => undefined).finally(() => { settled = true; });
        };
        const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) request();
        }, { rootMargin: '80px' });
        if (observer && target.current) observer.observe(target.current); else request();
        return () => {
            active = false; observer?.disconnect();
            if (requested && !settled) void invoke('cmd_workspace_cancel_asset', { ownerId, requestId }).catch(() => undefined);
        };
    }, [file.key, file.encryption_state, ownerId, identity]);
    const source = asset?.identity === identity ? asset.source : null;
    return <div ref={target} className="flex h-full w-full items-center justify-center overflow-hidden bg-telegram-hover/40">{source ? <img src={source} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setAsset(null)} /> : <FileTypeIcon filename={file.name} className="h-10 w-10 opacity-60" />}</div>;
}

type TimelineRow = { key: string; month: string; files?: WorkspaceFile[] };
type FileMenu = { file: WorkspaceFile; x: number; y: number; trigger: HTMLElement | null };
export function MediaTimeline({ ownerId, files, selected, onSelect, onOpen, onFolder, onFavorite, onOrganize, gallery }: {
    ownerId: string; files: WorkspaceFile[]; selected: Set<string>; onSelect: (key: string) => void;
    onOpen: (file: WorkspaceFile, orderedFiles?: WorkspaceFile[]) => void; onFolder: (folder: number | null) => void;
    onFavorite: (file: WorkspaceFile) => void; onOrganize: (file: WorkspaceFile) => void; gallery: boolean;
}) {
    const { t, i18n } = useTranslation();
    const container = useRef<HTMLDivElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const menuId = useId();
    const [columns, setColumns] = useState(3);
    const [context, setContext] = useState<FileMenu | null>(null);
    const months = useMemo(() => groupTimeline(files), [files]);
    const orderedFiles = useMemo(() => gallery ? months.flatMap(group => group.files) : files, [files, months, gallery]);
    const rows = useMemo<TimelineRow[]>(() => gallery ? months.flatMap(group => [
        { key: `month:${group.month}`, month: group.month },
        ...Array.from({ length: Math.ceil(group.files.length / columns) }, (_, index) => {
            const files = group.files.slice(index * columns, (index + 1) * columns);
            return { key: `files:${files[0].key}`, month: group.month, files };
        }),
    ]) : files.map(file => ({ key: file.key, month: '', files: [file] })), [months, files, columns, gallery]);
    const virtual = useVirtualizer({
        count: rows.length, getScrollElement: () => container.current,
        estimateSize: index => !rows[index].files ? 48 : gallery ? 225 : 88,
        getItemKey: index => rows[index].key, overscan: 3,
    });
    useEffect(() => {
        if (!container.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (entry) setColumns(Math.max(1, Math.min(6, Math.floor(entry.contentRect.width / 210))));
        });
        observer.observe(container.current);
        return () => observer.disconnect();
    }, []);
    useEffect(() => { virtual.measure(); }, [gallery, columns, virtual]);
    const closeContext = useCallback(() => setContext(null), []);
    useEffect(() => {
        if (!context) return;
        menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node)) closeContext(); };
        const escape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContext(); }
        };
        window.addEventListener('pointerdown', outside, true);
        window.addEventListener('keydown', escape);
        window.addEventListener('resize', closeContext);
        container.current?.addEventListener('scroll', closeContext);
        const scrollElement = container.current;
        return () => {
            window.removeEventListener('pointerdown', outside, true);
            window.removeEventListener('keydown', escape);
            window.removeEventListener('resize', closeContext);
            scrollElement?.removeEventListener('scroll', closeContext);
            if (context.trigger?.isConnected) context.trigger.focus({ preventScroll: true });
        };
    }, [context, closeContext]);
    const openContext = (event: MouseEvent<HTMLElement>, file: WorkspaceFile) => {
        event.preventDefault(); event.stopPropagation();
        const trigger = event.currentTarget.closest('article')?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? event.currentTarget;
        const rect = trigger.getBoundingClientRect();
        const keyboard = event.clientX === 0 && event.clientY === 0;
        setContext({ file, trigger, x: Math.max(8, Math.min(keyboard ? rect.left : event.clientX, window.innerWidth - 232)), y: Math.max(8, Math.min(keyboard ? rect.bottom : event.clientY, window.innerHeight - 160)) });
    };
    const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, file: WorkspaceFile) => {
        if (!gallery || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : null;
        if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const current = orderedFiles.findIndex(item => item.key === file.key);
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? orderedFiles.length - 1 : Math.max(0, Math.min(orderedFiles.length - 1, current + (delta ?? 0)));
        const next = orderedFiles[nextIndex];
        if (!next) return;
        virtual.scrollToIndex(rows.findIndex(row => row.files?.some(file => file.key === next.key)), { align: 'auto' });
        const focus = () => Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[data-workspace-open]') ?? []).find(button => button.dataset.workspaceOpen === next.key)?.focus({ preventScroll: true });
        requestAnimationFrame(() => { focus(); requestAnimationFrame(focus); });
    };
    const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Tab') { event.preventDefault(); closeContext(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
    };
    const monthLabel = (month: string) => month === 'unknown' ? t('workspace.unknown_date') : new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`));
    const activate = (action: (file: WorkspaceFile) => void) => { if (context) action(context.file); closeContext(); };
    return <section className="min-w-0 space-y-3">
        {gallery && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-telegram-subtext">{t('workspace.upload_dates')}</p><label className="flex items-center gap-2 text-xs">{t('workspace.jump_month')}<select aria-label={t('workspace.jump_month')} className="min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3" defaultValue="" onChange={event => {
            const index = rows.findIndex(row => row.month === event.target.value);
            if (index >= 0) virtual.scrollToIndex(index, { align: 'start' });
        }}><option value="" disabled>{t('common.date')}</option>{months.map(group => <option key={group.month} value={group.month}>{monthLabel(group.month)}</option>)}</select></label></div>}
        {files.length === 0 && <div className="rounded-2xl border border-dashed border-telegram-border p-10 text-center"><Image className="mx-auto mb-3 h-9 w-9 text-telegram-subtext" /><p className="text-sm">{t('workspace.no_matches')}</p></div>}
        <div ref={container} role="region" tabIndex={0} className="relative h-[min(65vh,850px)] min-h-64 overflow-auto" aria-label={t(gallery ? 'workspace.timeline' : 'common.files')}>
            <div style={{ height: virtual.getTotalSize(), position: 'relative', width: '100%' }}>
                {virtual.getVirtualItems().map(item => {
                    const row = rows[item.index];
                    return <div key={item.key} data-index={item.index} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)`, height: item.size }}>
                        {!row.files ? <h3 className="pt-4 text-sm font-semibold">{monthLabel(row.month)}</h3> : <div className={gallery ? 'grid gap-3 pb-3' : 'pb-2'} style={gallery ? { gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` } : undefined}>{row.files.map(file => <article key={file.key} data-file-key={file.key} className={`group relative min-w-0 overflow-hidden rounded-2xl border ${selected.has(file.key) ? 'border-telegram-primary bg-telegram-primary/10' : 'border-telegram-border bg-telegram-surface/50'} ${gallery ? '' : 'flex h-20 items-center gap-3 p-2'}`} onContextMenu={event => openContext(event, file)}>
                            <button type="button" data-workspace-open={file.key} onClick={() => onOpen(file, orderedFiles)} onKeyDown={event => moveFocus(event, file)} aria-label={t('workspace.open_file', { name: file.name })} className={gallery ? 'relative block h-32 w-full' : 'h-14 w-14 shrink-0 overflow-hidden rounded-xl'}>
                                {(isImageFile(file.name) || isVideoFile(file.name, file.mime_type)) ? <WorkspaceThumbnail ownerId={ownerId} file={file} /> : <FileTypeIcon filename={file.name} className="mx-auto h-8 w-8" />}
                                {gallery && isVideoFile(file.name, file.mime_type) && <Play className="absolute bottom-2 right-2 h-6 w-6 rounded-full bg-black/60 p-1 text-white" />}
                            </button>
                            <button type="button" onClick={() => onSelect(file.key)} aria-label={t('workspace.select_file', { name: file.name })} aria-pressed={selected.has(file.key)} className={gallery ? 'absolute start-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/70 bg-black/50 text-white' : 'flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-telegram-border'}>{selected.has(file.key) ? <Check className="h-4 w-4" /> : <span className="h-3 w-3 rounded border border-current" />}</button>
                            <div className={gallery ? 'px-3 py-2 pe-14' : 'min-w-0 flex-1'}><button type="button" onClick={() => onOpen(file, orderedFiles)} className="block max-w-full truncate text-start text-sm font-medium">{file.name}</button><button type="button" onClick={() => onFolder(file.folder_id)} className="mt-1 block max-w-full truncate text-start text-xs text-telegram-subtext hover:text-telegram-primary">{file.folderName} · {formatBytes(file.size)}</button><div className="mt-1 flex gap-1 overflow-hidden">{file.tags.slice(0, 3).map(tag => <span key={tag} className="truncate rounded bg-telegram-hover px-1.5 text-[10px] text-telegram-subtext">{tag}</span>)}</div></div>
                            <button type="button" onClick={() => onFavorite(file)} aria-label={t('workspace.favorite_file', { name: file.name })} aria-pressed={file.is_favorite} className={gallery ? 'absolute end-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-black/50 text-white' : 'min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover'}><Star className={`mx-auto h-4 w-4 ${file.is_favorite ? 'fill-amber-400 text-amber-400' : ''}`} /></button>
                            <button type="button" aria-haspopup="menu" aria-controls={context?.file.key === file.key ? menuId : undefined} aria-expanded={context?.file.key === file.key} aria-label={t('workspace.file_actions', { name: file.name })} onClick={event => openContext(event, file)} className={gallery ? 'absolute end-2 bottom-2 min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover' : 'min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover'}><MoreHorizontal className="mx-auto h-5 w-5" /></button>
                        </article>)}</div>}
                    </div>;
                })}
            </div>
        </div>
        {context && <div id={menuId} ref={menu} role="menu" aria-label={t('workspace.file_actions', { name: context.file.name })} onKeyDown={menuKey} className="fixed z-[80] w-56 rounded-xl border border-telegram-border bg-telegram-surface p-1.5 shadow-2xl" style={{ left: context.x, top: context.y }}>
            <button role="menuitem" tabIndex={-1} type="button" onClick={() => activate(onOrganize)} className="min-h-11 w-full rounded-lg px-3 text-start text-sm hover:bg-telegram-hover">{t('workspace.organize_file')}</button>
            <button role="menuitem" tabIndex={-1} type="button" onClick={() => activate(file => onFolder(file.folder_id))} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-start text-sm hover:bg-telegram-hover"><FolderOpen className="h-4 w-4" />{t('workspace.open_original')}</button>
            <button role="menuitem" tabIndex={-1} type="button" onClick={() => activate(onFavorite)} className="min-h-11 w-full rounded-lg px-3 text-start text-sm hover:bg-telegram-hover">{t('common.favorites')}</button>
        </div>}
    </section>;
}
