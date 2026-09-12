import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Download, FolderOpen, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { actOnOfflinePack, createOfflinePack, offlinePackMessages, offlinePackPath, offlinePackTotals, readOfflinePacks, type OfflinePack, type OfflinePackAction, type OfflinePackSnapshot } from '../../services/offlinePacks';
import type { WorkspaceFile } from '../../services/workspace';
import { formatBytes } from '../../utils';

export interface OfflinePacksPanelProps {
  ownerId: string;
  selectedFiles: WorkspaceFile[];
  collectionName?: string;
  onOpen: (file: WorkspaceFile, path?: string, isCurrent?: () => boolean) => void | Promise<void>;
}
const control = 'min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm disabled:opacity-50';

export function OfflinePacksPanel({ ownerId, selectedFiles, collectionName, onOpen }: OfflinePacksPanelProps) {
  const { t } = useTranslation();
  const text = (key: keyof typeof offlinePackMessages, values?: Record<string, string | number>) => t(`offlinePacks.${key}`, { defaultValue: offlinePackMessages[key], ...values });
  const [snapshot, setSnapshot] = useState<OfflinePackSnapshot | null>(null);
  const [name, setName] = useState(collectionName || text('default_name'));
  const [wifiOnly, setWifiOnly] = useState(true);
  const [expiryDays, setExpiryDays] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const generation = useRef(0);
  const owner = useRef(ownerId);
  const ownerEpoch = useRef(0);
  if (owner.current !== ownerId) { owner.current = ownerId; ownerEpoch.current++; }
  const files = useMemo(() => [...new Map(selectedFiles.map(file => [file.key, file])).values()], [selectedFiles]);
  const required = files.filter(file => !file.encryption_state || file.encryption_state === 'plain').reduce((sum, file) => sum + file.size, 0);
  const protectedFiles = files.some(file => file.encryption_state && file.encryption_state !== 'plain');
  const data = snapshot?.ownerId === ownerId ? snapshot : null;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await readOfflinePacks(ownerId);
      if (request === generation.current && owner.current === ownerId) setSnapshot(result);
    } catch { if (request === generation.current && owner.current === ownerId) setError(true); }
  }, [ownerId]);
  useEffect(() => {
    setSnapshot(null); setError(false); setBusy(null); setExpanded(null); setRemove(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    let disposed = false; let unlisten: (() => void) | undefined;
    void listen<{ ownerId: string }>('offline-pack-changed', event => { if (event.payload.ownerId === ownerId) void refresh(); }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; generation.current++; ownerEpoch.current++; window.clearInterval(timer); unlisten?.(); };
  }, [ownerId, refresh]);

  const perform = async (key: string, action: (isCurrent: () => boolean) => Promise<unknown>) => {
    if (busy) return;
    const expectedOwner = ownerId;
    const expectedEpoch = ownerEpoch.current;
    const isCurrent = () => owner.current === expectedOwner && ownerEpoch.current === expectedEpoch;
    setBusy(key); setError(false);
    try { await action(isCurrent); if (isCurrent()) await refresh(); }
    catch { if (isCurrent()) setError(true); }
    finally { if (isCurrent()) setBusy(null); }
  };
  const packAction = (pack: OfflinePack, action: OfflinePackAction, fileKey?: string) => void perform(pack.id, () => actOnOfflinePack(ownerId, pack.id, action, fileKey));
  const status = (value: string) => text((value === 'error' ? 'failed' : value) as keyof typeof offlinePackMessages);
  const waiting = (reason: string | null) => text(reason === 'WAITING_FOR_WIFI' ? 'waiting_wifi' : reason === 'WAITING_FOR_STORAGE' ? 'waiting_storage' : reason === 'NETWORK_STATUS_UNKNOWN' ? 'network_unknown' : 'waiting_network');

  return <section className="space-y-4" aria-label={text('title')}>
    <header><h2 className="text-lg font-semibold">{text('title')}</h2><p className="mt-1 text-sm text-telegram-subtext">{text('description')}</p></header>
    <form className="space-y-3 rounded-2xl border border-telegram-border p-4" onSubmit={event => { event.preventDefault(); void perform('create', async isCurrent => {
      const pack = await createOfflinePack(ownerId, name.trim(), files, wifiOnly, expiryDays ? Date.now() + expiryDays * 86_400_000 : null);
      if (isCurrent()) await actOnOfflinePack(ownerId, pack.id, 'start');
    }); }}>
      <label className="block text-sm">{text('name')}<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} className={`${control} mt-1 w-full`} /></label>
      <p className="text-sm font-medium">{files.length ? text('selection', { count: files.length, size: formatBytes(required) }) : text('select_files')}</p>
      {files.length > 0 && <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">{text('selected_list')}</summary><ol className="max-h-48 space-y-1 overflow-auto rounded-lg bg-telegram-bg p-2">{files.map(file => <li key={file.key} className="flex justify-between gap-3"><span className="truncate">{file.folderName} / {file.name}</span><span className="shrink-0">{formatBytes(file.size)}</span></li>)}</ol></details>}
      {data && <p className="text-xs text-telegram-subtext">{text('free_space', { size: formatBytes(data.freeBytes), reserve: formatBytes(data.reserveBytes) })}</p>}
      {data && required + data.reserveBytes > data.freeBytes && <p className="text-xs text-amber-400">{text('low_space')}</p>}
      {protectedFiles && <p className="text-xs text-amber-400">{text('protected_note')}</p>}
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={wifiOnly} onChange={event => setWifiOnly(event.target.checked)} />{text('wifi_only')}</label>
      <label className="flex flex-wrap items-center gap-2 text-sm">{text('expires')}<select value={expiryDays} onChange={event => setExpiryDays(Number(event.target.value))} className={control}><option value={0}>{text('never')}</option>{[7, 14, 30, 90].map(days => <option key={days} value={days}>{text('days', { count: days })}</option>)}</select></label>
      <p className="text-xs text-telegram-subtext">{text('expiry_note')}</p>
      <button disabled={busy !== null || !files.length || !name.trim()} className={`${control} flex items-center gap-2 text-telegram-primary`}><Download className="h-4 w-4" />{text(busy === 'create' ? 'creating' : 'download')}</button>
    </form>
    {error && <p role="alert" className="rounded-xl border border-amber-400/40 p-3 text-sm">{text('error')}</p>}
    <p className="text-xs text-telegram-subtext">{text('ready_note')} {text('resume_note')}</p>
    {data?.packs.length === 0 && <p className="py-6 text-center text-sm text-telegram-subtext">{text('no_packs')}</p>}
    {data?.packs.map(pack => {
      const totals = offlinePackTotals(pack);
      const active = ['running', 'queued', 'waiting'].includes(pack.status);
      return <article key={pack.id} className="space-y-3 rounded-2xl border border-telegram-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words font-semibold">{pack.name}</h3><span className={`text-xs ${pack.status === 'ready' ? 'text-green-500' : 'text-telegram-subtext'}`}>{status(pack.status)}</span></div>
        <p className="text-xs">{text('progress', { ready: totals.readyFiles, count: totals.totalFiles, size: formatBytes(totals.downloadedBytes) })}</p>
        <progress className="h-2 w-full accent-telegram-primary" max={Math.max(1, totals.totalBytes)} value={totals.downloadedBytes} aria-label={pack.name} />
        {pack.status === 'waiting' && <p role="status" className="text-xs text-amber-400">{waiting(pack.waitingReason)}</p>}
        {pack.expiresAt && <p className="text-xs text-telegram-subtext">{text('expires_at', { date: new Date(pack.expiresAt).toLocaleString() })}</p>}
        <div className="flex flex-wrap gap-2">
          {active ? <><button disabled={busy !== null} type="button" onClick={() => packAction(pack, 'pause')} className={`${control} flex items-center gap-2`}><Pause className="h-4 w-4" />{text('pause')}</button><button disabled={busy !== null} type="button" onClick={() => packAction(pack, 'cancel')} className={control}>{text('cancel')}</button></>
            : pack.status !== 'ready' && pack.status !== 'expired' && <button disabled={busy !== null} type="button" onClick={() => packAction(pack, 'retry')} className={`${control} flex items-center gap-2`}><Play className="h-4 w-4" />{text(pack.status === 'error' ? 'retry' : 'resume')}</button>}
          <button type="button" onClick={() => { setExpanded(expanded === pack.id ? null : pack.id); setLimit(100); }} className={control}>{text('files')}</button>
          <button disabled={busy !== null} type="button" onClick={() => setRemove(pack.id)} className={`${control} flex items-center gap-2`}><Trash2 className="h-4 w-4" />{text('remove')}</button>
        </div>
        {remove === pack.id && <div role="group" aria-label={text('remove_title')} className="space-y-2 rounded-xl border border-amber-400/40 p-3"><p className="text-sm font-semibold">{text('remove_title')}</p><p className="text-xs text-telegram-subtext">{text('remove_description')}</p><div className="flex gap-2"><button type="button" disabled={busy !== null} onClick={() => { packAction(pack, 'remove'); setRemove(null); }} className={control}>{text('remove_confirm')}</button><button type="button" onClick={() => setRemove(null)} className={control}>{text('back')}</button></div></div>}
        {expanded === pack.id && <><ul className="space-y-2">{pack.files.slice(0, limit).map(item => <li key={item.file.key} className="rounded-xl bg-telegram-bg p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="break-words text-sm">{item.file.name}</p><p className="mt-1 text-xs text-telegram-subtext">{status(item.status)} · {formatBytes(item.downloadedBytes)} / {formatBytes(item.file.size)}</p></div><div className="flex shrink-0 flex-wrap gap-1">
          {item.status === 'ready' && <button type="button" disabled={busy !== null} aria-label={`${text('open')} ${item.file.name}`} onClick={() => void perform(pack.id, async isCurrent => { const path = await offlinePackPath(ownerId, pack.id, item.file.key); if (isCurrent()) await onOpen(item.file, path, isCurrent); })} className={`${control} flex items-center gap-2`}><FolderOpen className="h-4 w-4" />{text('open')}</button>}
          {['error', 'cancelled'].includes(item.status) && <button type="button" disabled={busy !== null} onClick={() => packAction(pack, 'retry_file', item.file.key)} className={control} aria-label={`${text('file_retry')} ${item.file.name}`}><RefreshCw className="h-4 w-4" /></button>}
          {['pending', 'downloading'].includes(item.status) && <button type="button" disabled={busy !== null} onClick={() => packAction(pack, 'cancel_file', item.file.key)} className={control} aria-label={`${text('file_cancel')} ${item.file.name}`}>{text('file_cancel')}</button>}
        </div></div>{item.status === 'unsupported' && <p className="mt-2 text-xs text-amber-400">{text('protected_note')}</p>}</li>)}</ul>{pack.files.length > limit && <button type="button" className={control} onClick={() => setLimit(value => value + 100)}>{text('load_more')}</button>}</>}
      </article>;
    })}
  </section>;
}
