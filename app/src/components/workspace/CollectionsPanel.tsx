import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, Heart, Plane, Briefcase, Film, BookOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Collection, SavedSearch, WorkspaceFile, WorkspaceMutation } from '../../services/workspace';
import { WorkspaceThumbnail } from './MediaTimeline';

export const collectionIcons = { folder: Folder, heart: Heart, plane: Plane, briefcase: Briefcase, film: Film, book: BookOpen };
export const collectionColors = { blue: '#60a5fa', green: '#4ade80', amber: '#fbbf24', rose: '#fb7185', violet: '#a78bfa', slate: '#94a3b8' };
const control = 'min-h-11 w-full rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm';

export function CollectionsPanel({ ownerId, files, collections, searches, active, onSelect, onSearch, onEditSearch, mutate, reportError }: {
    ownerId: string; files: WorkspaceFile[];
    collections: Collection[]; searches: SavedSearch[]; active: string | null;
    onSelect: (id: string | null) => void; onSearch: (search: SavedSearch) => void;
    onEditSearch: (search: SavedSearch) => void;
    mutate: (mutation: WorkspaceMutation) => Promise<void>; reportError: (error: unknown) => void;
}) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState<Collection | null>(null);
    const [busy, setBusy] = useState(false);
    const perform = async (operation: () => Promise<void>) => { setBusy(true); try { await operation(); } catch (error) { reportError(error); } finally { setBusy(false); } };
    return <aside className="min-w-0 space-y-5 rounded-2xl border border-telegram-border bg-telegram-surface/40 p-3">
        <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('workspace.collections')}</h2><button type="button" aria-label={t('workspace.create_collection')} onClick={() => setEditing({ id: crypto.randomUUID(), name: '', color: 'blue', icon: 'folder', coverKey: null })} className="min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover"><Plus className="mx-auto h-4 w-4" /></button></div>
        <button type="button" onClick={() => onSelect(null)} aria-pressed={active === null} className={`${control} text-start ${active === null ? 'border-telegram-primary text-telegram-primary' : ''}`}>{t('common.all')}</button>
        <ul className="space-y-1">{collections.map(collection => {
            const Icon = collectionIcons[collection.icon as keyof typeof collectionIcons] || Folder;
            const cover = files.find(file => file.key === collection.coverKey);
            return <li key={collection.id} className="flex min-w-0 gap-1"><button type="button" aria-pressed={active === collection.id} onClick={() => onSelect(collection.id)} className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-start text-sm ${active === collection.id ? 'bg-telegram-primary/15' : 'hover:bg-telegram-hover'}`}>
                {cover ? <span className="h-9 w-12 shrink-0 overflow-hidden rounded-lg" data-testid={`collection-cover-${collection.id}`}><WorkspaceThumbnail ownerId={ownerId} file={cover} /></span> : <Icon className="h-4 w-4 shrink-0" style={{ color: collectionColors[collection.color as keyof typeof collectionColors] }} />}<span className="truncate">{collection.name}</span></button><button type="button" aria-label={t('workspace.edit_collection', { name: collection.name })} onClick={() => setEditing(collection)} className="min-h-11 min-w-11 rounded-xl hover:bg-telegram-hover"><Pencil className="mx-auto h-3.5 w-3.5" /></button></li>;
        })}</ul>
        {editing && <form onSubmit={event => { event.preventDefault(); void perform(async () => { await mutate({ type: 'save_collection', collection: { ...editing, name: editing.name.trim() } }); onSelect(editing.id); setEditing(null); }); }} className="space-y-3 rounded-xl border border-telegram-border p-3">
            <label className="block text-xs">{t('common.name')}<input autoFocus required maxLength={120} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} className={`${control} mt-1`} /></label>
            <label className="block text-xs">{t('workspace.color')}<select className={`${control} mt-1`} value={editing.color} onChange={event => setEditing({ ...editing, color: event.target.value })}>{Object.keys(collectionColors).map(color => <option key={color} value={color}>{t(`workspace.colors.${color}`)}</option>)}</select></label>
            <label className="block text-xs">{t('workspace.icon')}<select className={`${control} mt-1`} value={editing.icon} onChange={event => setEditing({ ...editing, icon: event.target.value })}>{Object.keys(collectionIcons).map(icon => <option key={icon} value={icon}>{t(`workspace.icons.${icon}`)}</option>)}</select></label>
            <div className="flex flex-wrap gap-2"><button disabled={busy} className="min-h-11 rounded-lg bg-telegram-primary px-3 text-sm text-black">{t('common.save')}</button><button type="button" onClick={() => setEditing(null)} className="min-h-11 px-3 text-sm">{t('common.cancel')}</button></div>
            {collections.some(c => c.id === editing.id) && <button type="button" disabled={busy} onClick={() => void perform(async () => { await mutate({ type: 'remove_collection', id: editing.id }); if (active === editing.id) onSelect(null); setEditing(null); })} className="flex min-h-11 items-center gap-2 text-start text-xs text-red-400"><Trash2 className="h-4 w-4" />{t('workspace.remove_collection')}</button>}
            <p className="text-xs leading-relaxed text-telegram-subtext">{t('workspace.collection_local')}</p>
        </form>}
        <div><h2 className="mb-2 text-sm font-semibold">{t('workspace.saved_searches')}</h2><ul className="space-y-1">{searches.map(search => <li key={search.id} className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => onSearch(search)} className="min-h-11 min-w-0 flex-1 truncate rounded-xl px-3 text-start text-sm hover:bg-telegram-hover">{search.name}</button><button type="button" onClick={() => onEditSearch(search)} aria-label={t('workspace.edit_search', { name: search.name })} className="min-h-11 min-w-11 rounded-xl text-telegram-subtext hover:bg-telegram-hover"><Pencil className="mx-auto h-3.5 w-3.5" /></button><button type="button" disabled={busy} onClick={() => void perform(() => mutate({ type: 'remove_search', id: search.id }))} aria-label={t('workspace.remove_search', { name: search.name })} className="min-h-11 min-w-11 rounded-xl text-telegram-subtext hover:bg-telegram-hover"><Trash2 className="mx-auto h-3.5 w-3.5" /></button></li>)}</ul></div>
    </aside>;
}
