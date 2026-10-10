import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from '../../../../context/SettingsContext';
import { formatBytes } from '../../../../utils';
import type { BandwidthWindow } from '../../../../types/settings';
import { SettingsToggle } from './SettingsControls';

const time = (minute: number) => `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minutes = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; };

export function BandwidthSettings() {
  const { t, i18n } = useTranslation();
  const { settings, updateSetting, isLoaded } = useSettings();
  const [quota, setQuota] = useState('');
  const [savedQuota, setSavedQuota] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    void invoke<{ limit_bytes: number }>('cmd_get_bandwidth').then(stats => {
      if (cancelled) return;
      const value = String(stats.limit_bytes / 1024 ** 3);
      setQuota(value); setSavedQuota(value); setFailed(false);
    }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [isLoaded]);
  const save = async () => {
    const bytes = Math.round(Number(quota) * 1024 ** 3);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) { setFailed(true); return; }
    setSaving(true);
    try {
      const stats = await invoke<{ limit_bytes: number }>('cmd_set_weekly_quota', { limitBytes: bytes });
      const value = String(stats.limit_bytes / 1024 ** 3);
      setQuota(value); setSavedQuota(value); setFailed(false);
    } catch { setFailed(true); } finally { setSaving(false); }
  };
  const windows = settings.bandwidthWindows;
  const edit = (index: number, patch: Partial<BandwidthWindow>) => updateSetting('bandwidthWindows', windows.map((window, i) => i === index ? { ...window, ...patch } : window));
  const rate = (label: string, value: number, change: (value: number) => void) => <label className="block text-xs text-telegram-subtext space-y-1">
    <span className="flex justify-between"><span>{label}</span><span>{value === 0 ? t('settings.unlimited') : `${formatBytes(value * 1024)}/s`}</span></span>
    <input type="range" min={0} max={5120} step={128} value={value} onChange={event => change(Number(event.target.value))} className="w-full accent-telegram-primary" />
  </label>;
  return <section className="rounded-lg bg-telegram-hover/50 p-3 space-y-3" aria-label={t('settings.bandwidth_throttle')}>
    <label className="flex items-center justify-between gap-2 text-sm text-telegram-text">
      <span>{t('settings.weekly_quota')}</span>
      <input type="number" min="0" step="any" value={quota} disabled={saving} onChange={event => setQuota(event.target.value)} className="w-24 rounded border border-telegram-border bg-telegram-bg p-1" />
      <button type="button" onClick={() => void save()} disabled={saving || quota === '' || quota === savedQuota} className="rounded border border-telegram-border px-2 py-1 disabled:opacity-40">{t('common.save')}</button>
    </label>
    {failed && <p role="alert" className="text-xs text-red-400">{t('common.operation_failed')}</p>}
    {rate(t('settings.download_limit'), settings.bandwidthLimitDownKBs, value => updateSetting('bandwidthLimitDownKBs', value))}
    <div className="flex items-center justify-between gap-2 text-sm text-telegram-text">
      <span>{t('settings.bandwidth_schedule')}</span>
      <SettingsToggle label={t('settings.bandwidth_schedule')} checked={settings.bandwidth_schedule} onChange={() => updateSetting('bandwidth_schedule', !settings.bandwidth_schedule)} />
    </div>
    {settings.bandwidth_schedule && <>
      {rate(t('settings.upload_limit'), settings.bandwidthLimitUpKBs, value => updateSetting('bandwidthLimitUpKBs', value))}
      {windows.map((window, index) => <fieldset key={index} className="rounded border border-telegram-border p-2 space-y-2 text-xs text-telegram-subtext">
        <legend>{t('settings.bandwidth_schedule')} {index + 1}</legend>
        <div role="group" aria-label={t('settings.window_days')} className="flex flex-wrap gap-2">
          {Array.from({ length: 7 }, (_, day) => <label key={day} className="inline-flex gap-1 items-center">
            <input type="checkbox" disabled={window.days.length === 1 && window.days.includes(day)} checked={window.days.includes(day)} onChange={() => edit(index, { days: window.days.includes(day) ? window.days.filter(value => value !== day) : [...window.days, day] })} />
            {new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 2 + day)))}
          </label>)}
        </div>
        <div className="flex flex-wrap gap-3">
          <label>{t('settings.window_start')} <input type="time" value={time(window.start_minute)} onChange={event => edit(index, { start_minute: minutes(event.target.value) })} className="rounded bg-telegram-bg p-1" /></label>
          <label>{t('settings.window_end')} <input type="time" value={time(window.end_minute)} onChange={event => edit(index, { end_minute: minutes(event.target.value) || 1440 })} className="rounded bg-telegram-bg p-1" /></label>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={window.pause} onChange={event => edit(index, { pause: event.target.checked })} />{t('settings.window_pause')}</label>
        {!window.pause && <>
          {rate(t('settings.upload_limit'), window.up_kbs, up_kbs => edit(index, { up_kbs }))}
          {rate(t('settings.download_limit'), window.down_kbs, down_kbs => edit(index, { down_kbs }))}
        </>}
        <button type="button" onClick={() => updateSetting('bandwidthWindows', windows.filter((_, i) => i !== index))} className="rounded border border-telegram-border px-2 py-1">{t('settings.window_remove')}</button>
      </fieldset>)}
      <button type="button" disabled={windows.length >= 32} onClick={() => updateSetting('bandwidthWindows', [...windows, { days: [0, 1, 2, 3, 4], start_minute: 480, end_minute: 1080, up_kbs: 0, down_kbs: 0, pause: false }])} className="rounded border border-telegram-border px-2 py-1 text-xs text-telegram-text disabled:opacity-40">{t('settings.window_add')}</button>
    </>}
  </section>;
}
