import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncPreview, SyncPreviewAction } from '../../../types/sync';

const PAGE_SIZE = 40;

export function SyncPlanPreview({ preview }: { preview: SyncPreview }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<SyncPreviewAction | 'all'>('all');
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); setFilter('all'); }, [preview]);
  const labels: Record<SyncPreviewAction, string> = {
    upload: t('syncPreview.uploads'), download: t('syncPreview.downloads'),
    delete_local: t('syncPreview.delete_local'), delete_remote: t('syncPreview.delete_remote'),
    conflict: t('syncPreview.conflicts'), skip: t('syncPreview.skipped'),
  };
  const categories: Array<{ action: SyncPreviewAction; count: number }> = [
    { action: 'upload', count: preview.counts.uploads }, { action: 'download', count: preview.counts.downloads },
    { action: 'delete_local', count: preview.counts.deleteLocal }, { action: 'delete_remote', count: preview.counts.deleteRemote },
    { action: 'conflict', count: preview.counts.conflicts }, { action: 'skip', count: preview.counts.skipped },
  ];
  const operations = preview.operations.filter(operation => filter === 'all' || operation.action === filter);
  const pages = Math.max(1, Math.ceil(operations.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);

  return <section className="space-y-3 rounded-lg border border-app-border p-3" aria-labelledby="sync-preview-title">
    <div>
      <h5 id="sync-preview-title" className="text-sm font-semibold text-app-text">{t('syncPreview.preview_title')}</h5>
      <p className="mt-1 text-xs leading-5 text-app-text-secondary">{t('syncPreview.preview_timestamp', { time: new Date(preview.generatedAt * 1000).toLocaleTimeString() })}</p>
      <p className="mt-1 text-xs text-app-text-tertiary">{t('syncPreview.local_files', { count: preview.localFiles })} · {t('syncPreview.remote_files', { count: preview.remoteFiles })}</p>
    </div>
    {preview.warnings.map(warning => <p key={warning} className="rounded-md bg-app-accent/5 px-3 py-2 text-xs leading-5 text-app-text-secondary">{warning}</p>)}
    {preview.pauseReasons.length > 0 && <div className="rounded-md border border-app-warning/30 bg-app-warning/5 p-3" role="status">
      <p className="text-xs font-semibold text-app-warning">{t('syncPreview.pause_reasons')}</p>
      <ul className="mt-1 list-disc space-y-1 ps-4 text-xs leading-5 text-app-text-secondary">{preview.pauseReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    <div className="flex flex-wrap gap-2" aria-label={t('syncPreview.preview_title')}>
      <button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setPage(0); }} className={`quiet-control rounded-md border px-2 py-1 text-xs ${filter === 'all' ? 'border-app-accent text-app-accent' : 'border-app-border text-app-text-secondary'}`}>{t('syncPreview.all')} ({preview.operations.length})</button>
      {categories.map(({ action, count }) => <button key={action} type="button" aria-pressed={filter === action} onClick={() => { setFilter(action); setPage(0); }} className={`quiet-control rounded-md border px-2 py-1 text-xs ${filter === action ? 'border-app-accent text-app-accent' : 'border-app-border text-app-text-secondary'}`}>{labels[action]} ({count})</button>)}
    </div>
    <div className="max-h-80 overflow-auto rounded-md border border-app-border">
      <table className="w-full text-start text-xs">
        <thead className="sticky top-0 bg-app-surface text-app-text-tertiary"><tr>
          <th className="px-3 py-2 text-start font-medium">{t('syncPreview.action')}</th>
          <th className="px-3 py-2 text-start font-medium">{t('syncPreview.path')}</th>
          <th className="px-3 py-2 text-start font-medium">{t('syncPreview.reason')}</th>
        </tr></thead>
        <tbody>{operations.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(operation => <tr key={`${operation.action}:${operation.relativePath}`} className="border-t border-app-border">
          <td className={`whitespace-nowrap px-3 py-2 align-top ${operation.action.startsWith('delete') ? 'text-app-danger' : operation.action === 'conflict' ? 'text-app-warning' : 'text-app-text-secondary'}`}>{labels[operation.action]}</td>
          <td className="max-w-56 break-words px-3 py-2 align-top font-medium text-app-text">{operation.relativePath}</td>
          <td className="min-w-44 px-3 py-2 align-top leading-5 text-app-text-secondary">{operation.detail}</td>
        </tr>)}</tbody>
      </table>
      {operations.length === 0 && <p className="p-4 text-center text-xs text-app-text-tertiary">{t('syncPreview.no_operations')}</p>}
    </div>
    {pages > 1 && <div className="flex items-center justify-between gap-3 text-xs text-app-text-secondary">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="quiet-control px-2 py-1 disabled:opacity-40">{t('syncPreview.previous')}</button>
      <span>{t('syncPreview.page', { current: currentPage + 1, total: pages })}</span>
      <button type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} className="quiet-control px-2 py-1 disabled:opacity-40">{t('syncPreview.next')}</button>
    </div>}
  </section>;
}
