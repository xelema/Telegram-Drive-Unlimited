import { AlertTriangle, Download } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useTranslation } from 'react-i18next';
import { isWindowsPlatform } from '../../utils/platform';

export const FFMPEG_WINDOWS_DOWNLOAD_URL = 'https://ffmpeg.org/download.html#build-windows';

export async function openFfmpegWindowsDownloads(): Promise<void> {
  try {
    await open(FFMPEG_WINDOWS_DOWNLOAD_URL);
  } catch {
    window.open(FFMPEG_WINDOWS_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
  }
}

interface FfmpegInstallNoticeProps {
  available: boolean | undefined;
  variant?: 'settings' | 'player';
}

export function FfmpegInstallNotice({ available, variant = 'settings' }: FfmpegInstallNoticeProps) {
  const { t } = useTranslation();

  if (available !== false || !isWindowsPlatform()) return null;

  const playerStyles = variant === 'player'
    ? 'mt-3 w-full border-amber-400/20 bg-amber-400/10 text-white'
    : 'border-amber-500/20 bg-amber-500/5 text-telegram-text';

  return (
    <div className={`rounded-lg border p-3 ${playerStyles}`} role="status">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{t('settings.ffmpeg_required_title')}</p>
          <p className={`mt-1 text-[11px] leading-relaxed ${variant === 'player' ? 'text-white/60' : 'text-telegram-subtext'}`}>
            {t('settings.ffmpeg_required_desc')}
          </p>
          <p className={`mt-1 text-[11px] leading-relaxed ${variant === 'player' ? 'text-white/50' : 'text-telegram-subtext'}`}>
            {t('settings.ffmpeg_restart_hint')}
          </p>
          <button
            type="button"
            onClick={() => void openFfmpegWindowsDownloads()}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-400/15 px-2.5 py-1.5 text-[11px] font-medium text-amber-300 transition hover:bg-amber-400/25"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t('settings.ffmpeg_download_windows')}
          </button>
        </div>
      </div>
    </div>
  );
}
