import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, Copy, Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { usePlatform } from '../../hooks/usePlatform';
import { invoke } from '@tauri-apps/api/core';
import type { VaultStatus } from '../../types';
import { supplyTransferPromptToken, transferItemAction } from '../../services/desktopTransferEngine';
import { adoptLegacyTransfers, discardLegacyTransfers, readTransferActivity, redactedTransferReport, protectedActivityMetadata, type ActivityJob } from '../../services/transferActivity';
import { userFacingError } from '../../services/userFacingError';
import { formatBytes } from '../../utils';

const button = 'min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm disabled:opacity-40';
const attention = (job: ActivityJob) => job.persistencePending || ['failed', 'paused', 'waiting_for_unlock', 'waiting_for_network', 'cooldown'].includes(job.status);

export function ActivityPanel({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation();
  const { isDesktop } = usePlatform();
  const query = useQuery({ queryKey: ['transfer-activity', ownerId], queryFn: () => readTransferActivity(ownerId), enabled: isDesktop, refetchInterval: 5_000 });
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const owner = useRef(ownerId);
  owner.current = ownerId;
  useEffect(() => { setSelected([]); setConfirmed(false); setShowLegacy(false); setShowReport(false); setMessage(''); setBusy(false); setFilter('all'); }, [ownerId]);
  const accountRejected = query.isError && String(query.error).includes('ACCOUNT_');
  const data = !accountRejected && query.data?.ownerId === ownerId ? query.data : undefined;
  const jobs = (data?.jobs ?? []).filter(job => filter === 'all' || (filter === 'uploads' && job.direction === 'upload') || (filter === 'downloads' && job.direction === 'download') || (filter === 'completed' && job.status === 'completed') || (filter === 'attention' && attention(job)));
  const selectedLegacy = (data?.legacy ?? []).filter(job => selected.includes(job.id));
  const report = redactedTransferReport(data?.jobs ?? []);
  const perform = async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true); setMessage(''); setFailed(false);
    try {
      await operation();
      if (owner.current !== ownerId) return;
      await query.refetch();
      if (owner.current !== ownerId) return;
      if (success) setMessage(success);
      setSelected([]); setConfirmed(false);
    } catch (error) {
      if (owner.current === ownerId) { setFailed(true); setMessage(userFacingError(error, t)); }
    } finally { if (owner.current === ownerId) setBusy(false); }
  };
  const retry = async (job: ActivityJob, action: 'resume' | 'retry') => {
    if (owner.current !== ownerId) throw new Error('ACCOUNT_CHANGED');
    if (!job.persistencePending) {
      const mode = job.protectionMode;
      const vault = mode === 'vault' || mode === 'vault_and_passphrase'
        ? await invoke<VaultStatus>('cmd_get_vault_status') : undefined;
      if (owner.current !== ownerId) throw new Error('ACCOUNT_CHANGED');
      if ((mode === 'vault' || (mode === 'vault_and_passphrase' && job.direction === 'upload')) && !vault?.is_unlocked) {
        window.dispatchEvent(new CustomEvent('telegram-drive-open-settings', { detail: { tab: 'encryption' } }));
        throw new Error('VAULT_LOCKED');
      }
      if (mode === 'passphrase' || (mode === 'vault_and_passphrase' && (job.direction === 'upload' || !vault?.is_unlocked))) {
        const secret = window.prompt(t('settings.encryption_mode_passphrase'));
        if (!secret) return;
        const token = await invoke<number>('cmd_stage_file_passphrase', { passphrase: secret });
        if (owner.current !== ownerId) throw new Error('ACCOUNT_CHANGED');
        await supplyTransferPromptToken(job.id, token);
      }
    }
    if (owner.current !== ownerId) throw new Error('ACCOUNT_CHANGED');
    await transferItemAction(action, job.id, ownerId);
  };
  if (!isDesktop) return <p className="text-sm leading-relaxed text-telegram-subtext">{t('activity.desktop_only')}</p>;

  return <section className="space-y-5">
    <header className="flex flex-wrap items-start gap-3"><Activity className="mt-1 h-6 w-6 text-telegram-primary" /><div className="min-w-0 flex-1"><h2 className="text-xl font-semibold">{t('activity.title')}</h2><p className="mt-2 text-sm text-telegram-subtext">{t('activity.description')}</p></div><button type="button" className={`${button} flex items-center gap-2`} disabled={busy || query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />{t('activity.refresh')}</button></header>
    {query.isLoading && <p role="status">{t('activity.loading')}</p>}
    {(message || query.isError) && <p role={failed || query.isError ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${failed || query.isError ? 'border-red-500/30 text-red-400' : 'border-telegram-border'}`}>{query.isError ? userFacingError(query.error, t) : message}</p>}
    <div className="flex flex-wrap gap-2">{['all', 'uploads', 'downloads', 'attention', 'completed'].map(value => <button key={value} type="button" className={`${button} ${filter === value ? 'border-telegram-primary text-telegram-primary' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`activity.${value}`)}</button>)}</div>
    {data && jobs.length === 0 && <p className="rounded-xl border border-telegram-border p-6 text-center text-sm text-telegram-subtext">{t('activity.empty')}</p>}
    <div className="space-y-3">{jobs.map(job => <article key={job.id} className="space-y-3 rounded-2xl border border-telegram-border bg-telegram-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-all font-medium">{protectedActivityMetadata(job) || !job.filename ? t('settings.protected') : job.filename}</h3><p className="mt-1 text-xs text-telegram-subtext">{t(job.direction === 'upload' ? 'activity.uploads' : 'activity.downloads')}{!protectedActivityMetadata(job) && ` · ${formatBytes(job.totalBytes)}`} · {t(job.downloadOutcome === 'skipped' ? 'downloadCollision.skipped' : `activity.status_${job.status}`)}</p></div><span className="text-xs text-telegram-subtext">{t('activity.progress', { progress: job.progress })}</span></div>
      {job.errorCategory && <p className="text-sm text-amber-400">{t(`activity.category_${job.errorCategory}`)}</p>}
      {job.persistencePending && <p className="text-sm leading-relaxed text-telegram-subtext">{t('activity.waiting_save')}</p>}
      {!protectedActivityMetadata(job) && job.error && <details className="text-xs text-telegram-subtext"><summary className="cursor-pointer">{t('activity.details')}</summary><p className="mt-2 break-all leading-relaxed">{job.error}</p></details>}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-telegram-subtext">{job.retryAt ? t('activity.retry_at', { time: new Date(job.retryAt).toLocaleString() }) : t('activity.updated_at', { time: new Date(job.updatedAt).toLocaleString() })}</p><div className="flex gap-2">
        {job.persistencePending ? <button type="button" disabled={busy} className={`${button} flex items-center gap-2`} onClick={() => void perform(() => retry(job, 'retry'))}><RotateCcw className="h-4 w-4" />{t('activity.retry_save')}</button> : job.status === 'paused' ? <button type="button" disabled={busy} className={`${button} flex items-center gap-2`} onClick={() => void perform(() => retry(job, 'resume'))}><Play className="h-4 w-4" />{t('activity.resume')}</button> : ['failed', 'cancelled', 'waiting_for_unlock', 'waiting_for_network', 'cooldown'].includes(job.status) ? <button type="button" disabled={busy} className={`${button} flex items-center gap-2`} onClick={() => void perform(() => retry(job, 'retry'))}><RotateCcw className="h-4 w-4" />{t('activity.retry')}</button> : job.status !== 'completed' && <button type="button" disabled={busy} className={`${button} flex items-center gap-2`} onClick={() => void perform(() => transferItemAction('pause', job.id, ownerId))}><Pause className="h-4 w-4" />{t('activity.pause')}</button>}
      </div></div>
    </article>)}</div>
    {data && data.jobs.length >= 500 && <p className="text-xs text-telegram-subtext">{t('activity.recent_limit')}</p>}
    {Boolean(data?.legacy.length) && <section className="space-y-3 rounded-2xl border border-amber-500/30 p-4"><h3 className="font-semibold">{t('activity.legacy_title')}</h3><p className="text-sm leading-relaxed text-telegram-subtext">{t('activity.legacy_description')}</p><button type="button" className={button} onClick={() => setShowLegacy(value => !value)}>{t('activity.legacy_show', { count: data?.legacy.length })}</button>{showLegacy && <>
      <p className="text-sm text-telegram-subtext">{t('activity.legacy_download')}</p>
      <div className="max-h-72 space-y-2 overflow-auto">{data?.legacy.map(job => <label key={job.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} aria-label={t('activity.legacy_select', { filename: job.filename || t('settings.protected') })} checked={selected.includes(job.id)} onChange={event => setSelected(current => event.target.checked ? [...current, job.id] : current.filter(id => id !== job.id))} /><span className="min-w-0 break-all">{job.filename || t('settings.protected')}<span className="ms-2 text-xs text-telegram-subtext">{t(job.direction === 'upload' ? 'activity.uploads' : 'activity.downloads')}</span></span></label>)}</div>
      <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />{t('activity.legacy_confirm')}</label><div className="flex flex-wrap gap-3"><button type="button" className={button} disabled={busy || !confirmed || selectedLegacy.length === 0 || selectedLegacy.some(job => !job.canAdopt)} onClick={() => void perform(() => adoptLegacyTransfers(ownerId, selected, confirmed), t('activity.legacy_saved'))}>{t('activity.legacy_adopt')}</button><button type="button" className={button} disabled={busy || selectedLegacy.length === 0} onClick={() => void perform(() => discardLegacyTransfers(ownerId, selected), t('activity.legacy_removed'))}>{t('activity.legacy_discard')}</button></div><p className="text-xs text-telegram-subtext">{t('activity.legacy_files_preserved')}</p>
    </>}</section>}
    {data && <section className="space-y-3"><button type="button" className={button} onClick={() => setShowReport(value => !value)}>{t('activity.diagnostics')}</button>{showReport && <><p className="max-w-3xl text-sm leading-relaxed text-telegram-subtext">{t('activity.diagnostics_description')}</p><textarea readOnly rows={8} value={report} aria-label={t('activity.report_label')} className="w-full rounded-xl border border-telegram-border bg-telegram-surface p-3 font-mono text-xs" /><button type="button" disabled={busy} className={`${button} flex items-center gap-2`} onClick={() => void perform(() => writeText(report), t('activity.report_copied'))}><Copy className="h-4 w-4" />{t('activity.copy_report')}</button></>}</section>}
  </section>;
}
