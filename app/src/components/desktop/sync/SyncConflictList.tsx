import { AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useSync } from '../../../context/SyncContext';
import type { ConflictResolution } from '../../../types/sync';

export function SyncConflictList({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { conflicts, resolveConflict } = useSync();
  const resolve = async (pairId: number, path: string, resolution: ConflictResolution) => {
    try { await resolveConflict(pairId, path, resolution); }
    catch (error) { toast.error(String(error)); }
  };
  return (
    <div className="fixed inset-x-6 bottom-6 z-[180] mx-auto max-w-3xl overflow-hidden rounded-xl border border-amber-500/30 bg-app-surface shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
      <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
        <h2 id="sync-conflict-title" className="flex items-center gap-2 text-sm font-semibold text-app-text"><AlertTriangle className="h-4 w-4 text-app-warning" />{t('sync.conflict.title')}</h2>
        <button type="button" onClick={onClose} className="quiet-control p-1.5 text-app-text-secondary"><X className="h-4 w-4" /></button>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-3">
        {(conflicts.data ?? []).map((conflict) => (
          <div key={`${conflict.pairId}:${conflict.relativePath}`} className="quiet-surface flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1"><p className="truncate text-sm text-app-text">{conflict.relativePath}</p><p className="truncate text-xs text-app-text-tertiary">{conflict.label ?? conflict.localPath}</p></div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => void resolve(conflict.pairId, conflict.relativePath, 'keep_local')} className="quiet-control border border-app-border px-2.5 py-1.5 text-xs text-app-text">{t('sync.conflict.keep_local')}</button>
              <button type="button" onClick={() => void resolve(conflict.pairId, conflict.relativePath, 'keep_remote')} className="quiet-control border border-app-border px-2.5 py-1.5 text-xs text-app-text">{t('sync.conflict.keep_remote')}</button>
              <button type="button" onClick={() => void resolve(conflict.pairId, conflict.relativePath, 'keep_both')} className="quiet-control bg-app-accent px-2.5 py-1.5 text-xs text-white">{t('sync.conflict.keep_both')}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
