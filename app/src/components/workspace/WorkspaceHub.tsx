import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowLeft, Check, Download, FolderPlus, HardDrive, Image, Library, Loader2, Play, RefreshCw, Search, Tag, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { DEFAULT_SEARCH_FILTERS, type FileSearchFilters } from '../../services/fileSearch';
import { filterWorkspaceFiles, savedSearchFolder, type WorkspaceFile, type SavedSearch } from '../../services/workspace';
import type { TelegramFile, TelegramFolder } from '../../types';
import { isImageFile, isVideoFile, isMediaFile } from '../../utils';
import { CollectionsPanel } from './CollectionsPanel';
import { MediaTimeline, WorkspaceThumbnail } from './MediaTimeline';
import { PhotoSlideshow } from './PhotoSlideshow';
import { mutatePlayback, toPlaybackFile } from '../../services/playbackHistory';

const ContinueWatchingShelf = lazy(() => import('../desktop/playback/ContinueWatchingShelf').then(module => ({ default: module.ContinueWatchingShelf })));
const OfflinePacksPanel = lazy(() => import('./OfflinePacksPanel').then(module => ({ default: module.OfflinePacksPanel })));
const CleanupPanel = lazy(() => import('./CleanupPanel').then(module => ({ default: module.CleanupPanel })));
const StoragePanel = lazy(() => import('./StoragePanel').then(module => ({ default: module.StoragePanel })));
const ActivityPanel = lazy(() => import('./ActivityPanel').then(module => ({ default: module.ActivityPanel })));
const control = 'min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm';

export interface WorkspaceHubProps { folders: TelegramFolder[]; initialKeys?: string[]; onClose: () => void; onOpen: (file: TelegramFile, orderedFiles?: TelegramFile[], localPath?: string) => void; onFolder: (id: number | null) => void }

export function WorkspaceHub({ folders, initialKeys = [], onClose, onOpen, onFolder }: WorkspaceHubProps) {
    const { t } = useTranslation();
    const workspace = useWorkspace();
    const [tab, setTab] = useState<'library' | 'timeline' | 'watch' | 'offline' | 'cleanup' | 'activity' | 'storage'>('library');
    const [collection, setCollection] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [filters, setFilters] = useState<FileSearchFilters>({ ...DEFAULT_SEARCH_FILTERS, scope: 'all' });
    const [folder, setFolder] = useState<number | null | 'all'>('all');
    const [tagFilters, setTagFilters] = useState<string[]>([]);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(() => new Set(initialKeys));
    const [targetCollection, setTargetCollection] = useState('');
    const [tag, setTag] = useState('');
    const [savedName, setSavedName] = useState('');
    const [saveSearchOpen, setSaveSearchOpen] = useState(false);
    const [editingSearchId, setEditingSearchId] = useState<string | null>(null);
    const [slideshow, setSlideshow] = useState<{ key?: string; keys: string[]; autoPlay: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const selectionControls = useRef<HTMLDivElement>(null);
    const owner = workspace.ownerId;
    const data = workspace.data?.ownerId === owner ? workspace.data : undefined;
    const files = useMemo(() => filterWorkspaceFiles(data?.files || [], query, filters, collection, tagFilters, folder)
        .filter(file => (!favoritesOnly || file.is_favorite) && (tab !== 'timeline' || isImageFile(file.name) || isVideoFile(file.name, file.mime_type))), [data?.files, query, filters, collection, tagFilters, folder, favoritesOnly, tab]);
    const photos = useMemo(() => files.filter(file => isImageFile(file.name)), [files]);
    const selectedFiles = useMemo(() => (data?.files || []).filter(file => selected.has(file.key)), [data?.files, selected]);
    const tags = useMemo(() => [...new Set(data?.files.flatMap(file => file.tags) || [])].sort(), [data?.files]);
    const reportError = (reason: unknown) => {
        const message = String(reason);
        setError(t(message.includes('ACCOUNT_') ? 'workspace.error_account' : message.includes('NETWORK_') ? 'workspace.error_network' : message.includes('STORAGE_') ? 'workspace.error_storage' : message.includes('ENCRYPTED_') ? 'workspace.error_protected' : 'workspace.error_operation'));
    };
    const perform = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); } catch (reason) { reportError(reason); } finally { setBusy(false); } };
    useEffect(() => { setSelected(new Set(initialKeys)); }, [initialKeys.join('|'), owner]);
    const open = (file: WorkspaceFile, orderedFiles: WorkspaceFile[] = files) => {
        if (isImageFile(file.name)) { setSlideshow({ key: file.key, keys: orderedFiles.filter(item => isImageFile(item.name)).map(item => item.key), autoPlay: false }); return; }
        onOpen(file, files);
    };
    const favorite = (file: WorkspaceFile) => { void perform(() => workspace.mutate({ type: 'favorite', key: file.key, value: !file.is_favorite })); };
    const select = (key: string) => setSelected(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    const selectSearch = (search: SavedSearch) => {
        setQuery(search.query); setFilters({ ...DEFAULT_SEARCH_FILTERS, ...search.filters });
        setTagFilters(search.tags ?? []); setFolder(savedSearchFolder(search));
        setCollection(search.collectionId ?? null); setFavoritesOnly(search.favoritesOnly ?? false);
    };
    const editSearch = (search: SavedSearch) => {
        selectSearch(search); setEditingSearchId(search.id); setSavedName(search.name); setSaveSearchOpen(true);
    };
    const slideshowFiles = useMemo(() => {
        const byKey = new Map(data?.files.map(file => [file.key, file]));
        return slideshow?.keys.flatMap(key => { const file = byKey.get(key); return file ? [file] : []; }) ?? [];
    }, [data?.files, slideshow]);
    const addQueue = async () => {
        if (!owner) return;
        const media = selectedFiles.filter(file => isMediaFile(file.name));
        await mutatePlayback(owner, { type: 'enqueue', files: media.map(file => toPlaybackFile(file)) });
    };

    return <div className="fixed inset-0 z-40 overflow-y-auto bg-telegram-bg text-telegram-text" data-testid="workspace-hub">
        <header className="sticky top-0 z-20 border-b border-telegram-border bg-telegram-bg/95 px-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
            <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 pb-3"><button type="button" aria-label={t('workspace.back')} onClick={onClose} className="min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover"><ArrowLeft className="mx-auto h-5 w-5" /></button><div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{t('workspace.title')}</h1><p className="mt-1 text-xs text-telegram-subtext">{t('workspace.subtitle')}</p></div><button type="button" disabled={!owner || workspace.indexing || busy} onClick={() => void perform(() => workspace.index([null, ...folders.map(folder => folder.id)]))} className={`${control} flex items-center gap-2 disabled:opacity-50`}><RefreshCw className={`h-4 w-4 ${workspace.indexing ? 'animate-spin' : ''}`} />{t(workspace.indexing ? 'workspace.scanning' : 'workspace.scan')}</button></div>
            <nav className="mx-auto flex max-w-[1600px] gap-1 overflow-x-auto" aria-label={t('workspace.views')}>{([['library', Library], ['timeline', Image], ['watch', Play], ['offline', Download], ['cleanup', Trash2], ['activity', Activity], ['storage', HardDrive]] as const).map(([value, Icon]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)} className={`flex min-h-12 shrink-0 items-center gap-2 border-b-2 px-4 text-sm ${tab === value ? 'border-telegram-primary text-telegram-primary' : 'border-transparent text-telegram-subtext'}`}><Icon className="h-4 w-4" />{t(`workspace.tabs.${value}`)}</button>)}</nav>
        </header>
        <main className="mx-auto max-w-[1600px] space-y-4 p-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:p-6">
            {(error || workspace.accountError || workspace.error) && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm"><p>{error || t(workspace.accountError ? 'workspace.error_account' : 'workspace.error_operation')}</p><button type="button" aria-label={t('common.close')} onClick={() => setError(null)} className="min-h-11 min-w-11"><X className="mx-auto h-4 w-4" /></button></div>}
            {(workspace.isLoading || busy) && <p role="status" className="flex items-center gap-2 text-sm text-telegram-subtext"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}</p>}
            {workspace.indexing && <p role="status" className="text-sm text-telegram-subtext">{t('workspace.scan_progress', { count: data?.files.length || 0 })}</p>}
            {owner && tab === 'watch' && <Suspense fallback={<p>{t('common.loading')}</p>}><ContinueWatchingShelf ownerId={owner} onPlay={file => onOpen(file)} /></Suspense>}
            {owner && tab === 'offline' && <Suspense fallback={<p>{t('common.loading')}</p>}><OfflinePacksPanel ownerId={owner} selectedFiles={selectedFiles} collectionName={data?.collections.find(item => item.id === collection)?.name} onOpen={(file,path,isCurrent) => { if (!isCurrent || isCurrent()) onOpen(file,undefined,path); }} /></Suspense>}
            {owner && data && tab === 'cleanup' && <Suspense fallback={<p>{t('common.loading')}</p>}><CleanupPanel ownerId={owner} files={data.files} onOpen={file => open(file)} onFolder={onFolder} /></Suspense>}
            {owner && tab === 'storage' && <Suspense fallback={<p>{t('common.loading')}</p>}><StoragePanel ownerId={owner}/></Suspense>}
            {owner && tab === 'activity' && <Suspense fallback={<p>{t('common.loading')}</p>}><ActivityPanel ownerId={owner}/></Suspense>}
            {owner && data && (tab === 'library' || tab === 'timeline') && <div className="grid min-w-0 gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
                <CollectionsPanel ownerId={owner} files={data.files} collections={data.collections} searches={data.searches} active={collection} onSelect={setCollection} onSearch={selectSearch} onEditSearch={editSearch} mutate={workspace.mutate} reportError={reportError} />
                <div className="min-w-0 space-y-4">
                    <div className="flex flex-wrap items-center gap-2"><div className="flex min-w-48 flex-1 items-center gap-2 rounded-xl border border-telegram-border bg-telegram-surface px-3"><Search className="h-4 w-4 text-telegram-subtext" /><input type="search" aria-label={t('common.search_placeholder')} placeholder={t('common.search_placeholder')} value={query} onChange={event => setQuery(event.target.value)} className="min-h-12 min-w-0 flex-1 bg-transparent text-sm outline-none" /></div><button type="button" onClick={() => { setEditingSearchId(null); setSavedName(''); setSaveSearchOpen(value => !value); }} className={control}>{t('workspace.save_search')}</button>{photos.length > 0 && <button type="button" onClick={() => setSlideshow({ keys: photos.map(file => file.key), autoPlay: true })} className={`${control} flex items-center gap-2`}><Play className="h-4 w-4" />{t('workspace.slideshow')}</button>}</div>
                    <div className="flex flex-wrap gap-2">
                        <select aria-label={t('common.folders')} className={control} value={folder === null ? 'saved' : folder} onChange={event => setFolder(event.target.value === 'all' ? 'all' : event.target.value === 'saved' ? null : Number(event.target.value))}><option value="all">{t('workspace.all_folders')}</option><option value="saved">{t('common.saved_messages')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
                        <select aria-label={t('workspace.file_type')} className={control} value={filters.type} onChange={event => setFilters({ ...filters, type: event.target.value as FileSearchFilters['type'] })}>{['all', 'image', 'video', 'audio', 'document', 'archive', 'other'].map(type => <option key={type} value={type}>{t(`workspace.types.${type}`)}</option>)}</select>
                        <select aria-label={t('common.size')} className={control} value={filters.size} onChange={event => setFilters({ ...filters, size: event.target.value as FileSearchFilters['size'] })}>{['any', 'small', 'medium', 'large'].map(size => <option key={size} value={size}>{t(`workspace.sizes.${size}`)}</option>)}</select>
                        <select aria-label={t('common.date')} className={control} value={filters.date} onChange={event => setFilters({ ...filters, date: event.target.value as FileSearchFilters['date'] })}>{['any', '7d', '30d', '1y'].map(date => <option key={date} value={date}>{t(`workspace.dates.${date}`)}</option>)}</select>
                        <select aria-label={t('workspace.tags')} className={control} value="" onChange={event => { if (event.target.value) setTagFilters(current => [...current, event.target.value]); }}><option value="">{t('workspace.add_tag_filter')}</option>{tags.filter(tag => !tagFilters.includes(tag)).map(tag => <option key={tag}>{tag}</option>)}</select>{tagFilters.map(tag => <button key={tag} type="button" className={`${control} flex items-center gap-1`} aria-label={t('workspace.remove_tag_filter', { tag })} onClick={() => setTagFilters(current => current.filter(value => value !== tag))}>{tag}<X className="h-3.5 w-3.5" /></button>)}
                        <label className={`${control} flex items-center gap-2`}><input type="checkbox" checked={favoritesOnly} onChange={event => setFavoritesOnly(event.target.checked)} />{t('common.favorites')}</label>
                    </div>
                    {saveSearchOpen && <form aria-label={t(editingSearchId ? 'workspace.edit_saved_search' : 'workspace.save_search')} className="flex flex-wrap gap-2 rounded-xl border border-telegram-border p-3" onSubmit={event => { event.preventDefault(); void perform(async () => { await workspace.mutate({ type: 'save_search', search: { id: editingSearchId ?? crypto.randomUUID(), name: savedName.trim(), query, filters, tags: tagFilters, folderKey: folder === 'all' ? null : folder === null ? 'saved' : String(folder), collectionId: collection, favoritesOnly } }); setSavedName(''); setSaveSearchOpen(false); setEditingSearchId(null); }); }}><label className="flex min-w-48 flex-1 items-center gap-2 text-sm">{t('common.name')}<input required maxLength={120} value={savedName} onChange={event => setSavedName(event.target.value)} className={`${control} min-w-0 flex-1`} /></label><button className={`${control} text-telegram-primary`} disabled={busy}>{t('common.save')}</button><button type="button" className={control} onClick={() => { setSaveSearchOpen(false); setEditingSearchId(null); }}>{t('common.cancel')}</button><p className="w-full text-xs text-telegram-subtext">{t('workspace.search_rules', { query: query || '*', type: t(`workspace.types.${filters.type}`), size: t(`workspace.sizes.${filters.size}`), date: t(`workspace.dates.${filters.date}`), tags: tagFilters.join(', ') || '*', folder: folder === 'all' ? t('workspace.all_folders') : folder === null ? t('common.saved_messages') : folders.find(item => item.id === folder)?.name ?? String(folder), collection: data.collections.find(item => item.id === collection)?.name ?? t('common.all'), favorites: t(favoritesOnly ? 'workspace.favorites_only' : 'common.all') })}</p></form>}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-telegram-subtext"><span>{t('workspace.result_count', { count: files.length })}</span><div className="flex gap-2"><button type="button" onClick={() => setSelected(new Set(files.map(file => file.key)))} className="min-h-11 rounded-lg px-3 hover:bg-telegram-hover">{t('workspace.select_all')}</button><button type="button" onClick={() => setSelected(new Set())} className="min-h-11 rounded-lg px-3 hover:bg-telegram-hover">{t('workspace.clear_selection')}</button></div></div>
                    {selected.size > 0 && <div ref={selectionControls} tabIndex={-1} className="space-y-3 rounded-2xl border border-telegram-primary/40 bg-telegram-primary/5 p-3">
                        <p className="flex items-center gap-2 text-sm font-medium"><Check className="h-4 w-4" />{t('workspace.selected_count', { count: selectedFiles.length })}</p>
                        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setTab('offline')} className={`${control} flex items-center gap-2 text-telegram-primary`}><Download className="h-4 w-4"/>{t('workspace.prepare_offline')}</button><select aria-label={t('workspace.choose_collection')} value={targetCollection} onChange={event => setTargetCollection(event.target.value)} className={`${control} min-w-40`}><option value="">{t('workspace.choose_collection')}</option>{data.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" disabled={!targetCollection || busy} onClick={() => void perform(() => workspace.mutate({ type: 'assign', keys: [...selected], collection: targetCollection, add: true }))} className={`${control} flex items-center gap-2 disabled:opacity-40`}><FolderPlus className="h-4 w-4" />{t('workspace.add_to_collection')}</button><button type="button" disabled={!targetCollection || busy} onClick={() => void perform(() => workspace.mutate({ type: 'assign', keys: [...selected], collection: targetCollection, add: false }))} className={`${control} disabled:opacity-40`}>{t('workspace.remove_membership')}</button>
                        {collection && selectedFiles.length === 1 && isImageFile(selectedFiles[0].name) && <button type="button" disabled={busy} onClick={() => void perform(() => workspace.mutate({ type: 'save_collection', collection: { ...data.collections.find(c => c.id === collection)!, coverKey: selectedFiles[0].key } }))} className={control}>{t('workspace.use_cover')}</button>}</div>
                        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void perform(() => workspace.mutate({ type: 'tag', keys: [...selected], tag, add: true })); }}><input aria-label={t('workspace.tag_name')} placeholder={t('workspace.tag_name')} required maxLength={40} value={tag} onChange={event => setTag(event.target.value)} className={`${control} min-w-36 flex-1`} /><button disabled={busy || !tag.trim()} className={`${control} flex items-center gap-2 disabled:opacity-40`}><Tag className="h-4 w-4" />{t('workspace.add_tag')}</button><button type="button" disabled={busy || !tag.trim()} onClick={() => void perform(() => workspace.mutate({ type: 'tag', keys: [...selected], tag, add: false }))} className={`${control} disabled:opacity-40`}>{t('workspace.remove_tag')}</button>{selectedFiles.some(file => isMediaFile(file.name)) && <button type="button" disabled={busy} onClick={() => void perform(addQueue)} className={control}>{t('workspace.add_queue')}</button>}</form>
                        <p className="text-xs text-telegram-subtext">{t('workspace.collection_local')}</p>
                    </div>}
                    {collection && (() => { const album = data.collections.find(c => c.id === collection); const cover = data.files.find(file => file.key === album?.coverKey); return cover ? <div className="flex items-center gap-4 rounded-2xl border border-telegram-border p-3"><div className="h-20 w-28 overflow-hidden rounded-xl"><WorkspaceThumbnail ownerId={owner} file={cover} /></div><div><h2 className="text-lg font-semibold">{album?.name}</h2><p className="text-xs text-telegram-subtext">{t('workspace.cover_selected')}</p></div></div> : null; })()}
                    <MediaTimeline ownerId={owner} files={files} selected={selected} onSelect={select} onOpen={open} onFolder={onFolder} onFavorite={favorite} onOrganize={file => { setSelected(new Set([file.key])); requestAnimationFrame(() => { selectionControls.current?.scrollIntoView({ block: 'nearest' }); selectionControls.current?.focus(); }); }} gallery={tab === 'timeline'} />
                </div>
            </div>}
        </main>
        {slideshow && owner && <PhotoSlideshow ownerId={owner} files={slideshowFiles} initialKey={slideshow.key} autoPlay={slideshow.autoPlay} onClose={() => setSlideshow(null)} onFavorite={favorite} />}
    </div>;
}
