import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Download, Pause, Play, RotateCcw, UploadCloud, X } from 'lucide-react';
import type { DownloadItem, QueueItem } from '../../../types';
import { formatBytes } from '../../../utils';

interface TransferCenterProps {
  uploads: QueueItem[];
  downloads: DownloadItem[];
  onClearUploads: () => void;
  onCancelUploads: () => void;
  onPauseUploads: () => void;
  onResumeUploads: () => void;
  onCancelUpload: (id: string) => void;
  onRetryUpload: (id: string) => void;
  onClearDownloads: () => void;
  onCancelDownloads: () => void;
  onPauseDownloads: () => void;
  onResumeDownloads: () => void;
  onCancelDownload: (id: string) => void;
  onRetryDownload: (id: string) => void;
}

function TransferProgress({ value, tone = 'accent' }: { value?: number; tone?: 'accent' | 'info' }) {
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-app-border">
      <div
        className={`h-full rounded-full transition-[width] ${tone === 'accent' ? 'bg-app-accent' : 'bg-app-info'}`}
        style={{ width: `${value ?? 18}%` }}
      />
    </div>
  );
}

function StatusLabel({ status }: { status: QueueItem['status'] | DownloadItem['status'] }) {
  const tone = status === 'success'
    ? 'text-app-success'
    : status === 'error'
      ? 'text-app-danger'
      : status === 'cancelled'
        ? 'text-app-text-tertiary'
        : status === 'paused'
          ? 'text-app-text-secondary'
        : status === 'pending'
          ? 'text-app-warning'
          : 'text-app-accent';
  return <span className={`text-[10px] font-medium capitalize ${tone}`}>{status}</span>;
}

export function TransferCenter({
  uploads,
  downloads,
  onClearUploads,
  onCancelUploads,
  onPauseUploads,
  onResumeUploads,
  onCancelUpload,
  onRetryUpload,
  onClearDownloads,
  onCancelDownloads,
  onPauseDownloads,
  onResumeDownloads,
  onCancelDownload,
  onRetryDownload,
}: TransferCenterProps) {
  const [expanded, setExpanded] = useState(true);
  if (uploads.length === 0 && downloads.length === 0) return null;

  const activeUploads = uploads.filter((item) => ['pending', 'uploading', 'downloading', 'encrypting', 'verifying'].includes(item.status)).length;
  const activeDownloads = downloads.filter((item) => ['pending', 'cooldown', 'downloading', 'decrypting', 'verifying'].includes(item.status)).length;
  const activeCount = activeUploads + activeDownloads;
  const pausedUploads = uploads.filter((item) => item.status === 'paused').length;
  const pausedDownloads = downloads.filter((item) => item.status === 'paused').length;
  const pausedCount = pausedUploads + pausedDownloads;
  const aggregateSpeed = [...uploads, ...downloads]
    .filter((item) => ['uploading', 'downloading', 'encrypting', 'decrypting', 'verifying'].includes(item.status))
    .reduce((sum, item) => sum + (item.speedBytesPerSec || 0), 0);
  const allComplete = activeCount === 0 && pausedCount === 0
    && [...uploads, ...downloads].length > 0
    && [...uploads, ...downloads].every((item) => item.status === 'success');

  return (
    <aside className="quiet-raised fixed bottom-4 start-4 z-50 w-[min(360px,calc(100vw-2rem))] overflow-hidden min-[1050px]:start-auto min-[1050px]:end-4" aria-label="Transfer activity">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center gap-3 border-b border-app-border-subtle px-4 py-3 text-start hover:bg-app-hover">
        <div className="flex h-8 w-8 items-center justify-center rounded-control bg-app-selected text-app-accent"><UploadCloud className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-app-text">Transfers</h3>
          <p className="text-[11px] text-app-text-secondary">
            {activeCount > 0
              ? `${activeCount} active${aggregateSpeed > 0 ? ` · ${formatBytes(aggregateSpeed)}/s` : ''}`
              : pausedCount > 0
                ? `${pausedCount} paused`
                : `${uploads.length + downloads.length} complete or stopped`}
          </p>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-app-text-secondary" /> : <ChevronUp className="h-4 w-4 text-app-text-secondary" />}
      </button>

      {expanded && (
        <div className="max-h-[min(420px,60vh)] overflow-y-auto">
          {uploads.length > 0 && (
            <section>
              <div className="flex items-center justify-between bg-app-surface-sunken/25 px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-secondary">Uploads</span>
                <div className="flex gap-3 text-[11px]">
                  {activeUploads > 0 && <button type="button" onClick={onPauseUploads} className="flex items-center gap-1 text-app-text-secondary"><Pause className="h-3 w-3" aria-hidden="true" />Pause all</button>}
                  {pausedUploads > 0 && <button type="button" onClick={onResumeUploads} className="flex items-center gap-1 text-app-accent"><Play className="h-3 w-3" aria-hidden="true" />Resume all</button>}
                  {activeUploads > 0 && <button type="button" onClick={onCancelUploads} className="text-app-danger">Cancel all</button>}
                  <button type="button" onClick={onClearUploads} className="text-app-accent">Clear finished</button>
                </div>
              </div>
              {uploads.map((item) => (
                <div key={item.id} className="border-t border-app-border-subtle px-4 py-3 first:border-t-0">
                  <div className="flex items-center gap-3">
                    <UploadCloud className="h-4 w-4 shrink-0 text-app-accent" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-app-text" title={item.url || item.path}>{(item.url || item.path).split(/[\\/]/).pop()}</p>
                      <StatusLabel status={item.status} />
                    </div>
                    {(item.status === 'pending' || item.status === 'paused' || item.status === 'uploading' || item.status === 'downloading' || item.status === 'encrypting' || item.status === 'verifying') && <button type="button" onClick={() => onCancelUpload(item.id)} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-danger" aria-label={`Cancel upload ${item.url || item.path}`} title="Cancel"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                    {(item.status === 'error' || item.status === 'cancelled' || item.status === 'waiting_for_unlock') && <button type="button" onClick={() => onRetryUpload(item.id)} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-accent" aria-label={`${item.status === 'waiting_for_unlock' ? 'Provide encryption credentials for' : 'Retry'} ${item.url || item.path}`} title={item.status === 'waiting_for_unlock' ? 'Provide encryption credentials' : 'Retry'}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                  </div>
                  {(item.status === 'uploading' || item.status === 'downloading') && <TransferProgress value={item.progress} />}
                  {item.error && <p className="mt-1 truncate text-[10px] text-app-danger">{item.error}</p>}
                </div>
              ))}
            </section>
          )}

          {downloads.length > 0 && (
            <section>
              <div className="flex items-center justify-between border-t border-app-border-subtle bg-app-surface-sunken/25 px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-secondary">Downloads</span>
                <div className="flex gap-3 text-[11px]">
                  {activeDownloads > 0 && <button type="button" onClick={onPauseDownloads} className="flex items-center gap-1 text-app-text-secondary"><Pause className="h-3 w-3" aria-hidden="true" />Pause all</button>}
                  {pausedDownloads > 0 && <button type="button" onClick={onResumeDownloads} className="flex items-center gap-1 text-app-accent"><Play className="h-3 w-3" aria-hidden="true" />Resume all</button>}
                  {activeDownloads > 0 && <button type="button" onClick={onCancelDownloads} className="text-app-danger">Cancel all</button>}
                  <button type="button" onClick={onClearDownloads} className="text-app-accent">Clear finished</button>
                </div>
              </div>
              {downloads.map((item) => (
                <div key={item.id} className="border-t border-app-border-subtle px-4 py-3 first:border-t-0">
                  <div className="flex items-center gap-3">
                    <Download className="h-4 w-4 shrink-0 text-app-info" />
                    <div className="min-w-0 flex-1"><p className="truncate text-xs text-app-text" title={item.filename}>{item.filename}</p><StatusLabel status={item.status} /></div>
                    {(item.status === 'pending' || item.status === 'paused' || item.status === 'cooldown' || item.status === 'downloading' || item.status === 'decrypting' || item.status === 'verifying') && <button type="button" onClick={() => onCancelDownload(item.id)} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-danger" aria-label={`Cancel download ${item.filename}`} title="Cancel"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                    {(item.status === 'error' || item.status === 'cancelled' || item.status === 'waiting_for_unlock') && <button type="button" onClick={() => onRetryDownload(item.id)} className="quiet-control p-1.5 text-app-text-secondary hover:text-app-accent" aria-label={`${item.status === 'waiting_for_unlock' ? 'Provide encryption credentials for' : 'Retry'} ${item.filename}`} title={item.status === 'waiting_for_unlock' ? 'Provide encryption credentials' : 'Retry'}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                  </div>
                  {(item.status === 'downloading' || item.status === 'decrypting' || item.status === 'verifying') && <TransferProgress value={item.progress} tone="info" />}
                  {item.error && <p className="mt-1 truncate text-[10px] text-app-danger">{item.error}</p>}
                </div>
              ))}
            </section>
          )}
          {allComplete && (
            <div className="flex flex-col items-center gap-2 border-t border-app-border-subtle px-5 py-5 text-center" role="status">
              <CheckCircle2 className="h-7 w-7 text-app-success" />
              <div>
                <p className="text-sm font-medium text-app-text">All transfers complete</p>
                <p className="mt-0.5 text-[11px] text-app-text-secondary">Your files are ready. Finished items can be cleared whenever you like.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
