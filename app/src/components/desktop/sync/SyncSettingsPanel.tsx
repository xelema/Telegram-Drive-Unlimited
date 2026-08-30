import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, FolderInput, HardDrive, Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useSync } from '../../../context/SyncContext';
import type { TelegramFolder } from '../../../types';
import { userFacingError } from '../../../services/userFacingError';

export function SyncSettingsPanel() {
  const { t } = useTranslation();
  const { settings, pairs, setEnabled, addPair, removePair } = useSync();
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const enabled = settings.data?.enabled ?? false;

  useEffect(() => {
    void invoke<TelegramFolder[]>('cmd_get_enriched_folders').then(setFolders).catch(() => setFolders([]));
  }, []);

  const selectedFolder = useMemo(() => folders.find((folder) => folder.id === channelId), [channelId, folders]);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: t('settings.sync.select_folder') });
    if (typeof selected === 'string') setSelectedPath(selected);
  };

  const savePair = async () => {
    if (!selectedPath || channelId === '') return;
    setBusy(true);
    try {
      await addPair(selectedPath, channelId, selectedFolder?.name);
      setSelectedPath(null);
      setChannelId('');
      toast.success(t('settings.sync.folder_added'));
    } catch (error) {
      toast.error(userFacingError(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5" aria-labelledby="folder-sync-title">
      <div className="quiet-surface flex items-start justify-between gap-5 p-4">
        <div className="flex gap-3">
          <FolderInput className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" />
          <div>
            <h3 id="folder-sync-title" className="text-sm font-semibold text-app-text">{t('settings.sync.title')}</h3>
            <p className="mt-1 max-w-lg text-xs leading-5 text-app-text-secondary">{t('settings.sync.description')}</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy || settings.isLoading}
          onClick={async () => {
            setBusy(true);
            try { await setEnabled(!enabled); }
            catch (error) { toast.error(userFacingError(error, t)); }
            finally { setBusy(false); }
          }}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? 'bg-app-accent' : 'bg-app-border-strong'} disabled:opacity-50`}
          aria-label={t('settings.sync.toggle')}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0.5 rtl:-translate-x-0.5'}`} />
        </button>
      </div>

      {!enabled && (
        <div className="rounded-lg border border-app-accent/25 bg-app-accent/5 p-4">
          <div className="flex gap-3">
            <HardDrive className="mt-0.5 h-5 w-5 text-app-accent" />
            <div>
              <p className="text-sm font-medium text-app-text">{t('settings.sync.off_by_default')}</p>
              <p className="mt-1 text-xs leading-5 text-app-text-secondary">{t('settings.sync.onboarding')}</p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-app-text-tertiary">{t('settings.sync.folder_mapper')}</h4>
          <p className="mt-1 text-xs text-app-text-secondary">{t('settings.sync.mapper_description')}</p>
        </div>

        {(pairs.data ?? []).map((pair) => (
          <div key={pair.id} className="quiet-surface flex items-center gap-3 p-3">
            <Link2 className="h-4 w-4 shrink-0 text-app-accent" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-app-text">{pair.label ?? pair.channelId}</p>
              <p className="truncate text-xs text-app-text-tertiary" title={pair.localPath}>{pair.localPath}</p>
            </div>
            <button type="button" onClick={() => void removePair(pair.id).catch((error) => toast.error(userFacingError(error, t)))} className="quiet-control p-2 text-app-danger" title={t('settings.sync.remove')}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}

        <div className="rounded-lg border border-dashed border-app-border p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <button type="button" onClick={chooseFolder} className="quiet-control min-w-0 border border-app-border px-3 py-2 text-start text-xs text-app-text">
              <span className="block truncate">{selectedPath ?? t('settings.sync.add_folder')}</span>
            </button>
            <select value={channelId} onChange={(event) => setChannelId(event.target.value ? Number(event.target.value) : '')} className="quiet-control border border-app-border bg-app-surface px-3 py-2 text-xs text-app-text">
              <option value="">{t('settings.sync.select_channel')}</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
            <button type="button" disabled={!selectedPath || channelId === '' || busy} onClick={savePair} className="quiet-control flex items-center justify-center gap-1.5 bg-app-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t('common.save')}
            </button>
          </div>
          {folders.length === 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-app-warning"><AlertTriangle className="h-3.5 w-3.5" />{t('settings.sync.no_channels')}</p>}
        </div>
      </div>
    </section>
  );
}
