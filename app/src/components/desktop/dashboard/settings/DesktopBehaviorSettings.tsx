import { useEffect, useState } from 'react';
import { Bell, Eye, MonitorUp, PanelTopClose } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_DESKTOP_PREFERENCES,
  getDesktopPreferences,
  getNotificationPermission,
  requestNotificationPermission,
  updateDesktopPreferences,
  type DesktopPreferences,
  type NotificationPermission,
} from '../../../../services/desktopLifecycle';
import { SettingsRow, SettingsToggle } from './SettingsControls';

export function DesktopBehaviorSettings() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<DesktopPreferences>(DEFAULT_DESKTOP_PREFERENCES);
  const [permission, setPermission] = useState<NotificationPermission>('prompt');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getDesktopPreferences(), getNotificationPermission()])
      .then(([nextPreferences, nextPermission]) => {
        if (!active) return;
        setPreferences(nextPreferences);
        setPermission(nextPermission);
      })
      .catch(() => {
        if (active) setPermission('unavailable');
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => { active = false; };
  }, []);

  const commit = async (updates: Partial<DesktopPreferences>) => {
    const previous = preferences;
    const next = { ...preferences, ...updates };
    setPreferences(next);
    try {
      setPreferences(await updateDesktopPreferences(next));
    } catch {
      setPreferences(previous);
      toast.error(t('settings.desktop_save_failed'));
    }
  };

  const toggleNotifications = async () => {
    if (preferences.notificationsEnabled) {
      await commit({ notificationsEnabled: false });
      return;
    }
    let nextPermission = permission;
    if (nextPermission === 'prompt') {
      nextPermission = await requestNotificationPermission().catch(() => 'unavailable');
      setPermission(nextPermission);
    }
    if (nextPermission !== 'granted') {
      toast.error(nextPermission === 'denied'
        ? t('settings.desktop_notifications_denied')
        : t('settings.desktop_notifications_unavailable'));
      return;
    }
    await commit({ notificationsEnabled: true });
  };

  const notificationControlsDisabled = !loaded || !preferences.notificationsEnabled;

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-telegram-subtext">
        <MonitorUp className="h-3.5 w-3.5" />
        {t('settings.desktop_behavior')}
      </h3>
      <SettingsRow
        icon={<PanelTopClose className="h-4 w-4 text-telegram-subtext" />}
        title={t('settings.desktop_background_mode')}
        description={t('settings.desktop_background_mode_desc')}
        control={<SettingsToggle disabled={!loaded} checked={preferences.backgroundModeEnabled} label={t('settings.desktop_background_mode')} onChange={() => void commit({ backgroundModeEnabled: !preferences.backgroundModeEnabled, closeBehavior: preferences.backgroundModeEnabled ? 'quit' : 'background' })} />}
      />
      <SettingsRow
        icon={<Bell className="h-4 w-4 text-telegram-subtext" />}
        title={t('settings.desktop_notifications')}
        description={permission === 'denied' ? t('settings.desktop_notifications_denied') : t('settings.desktop_notifications_desc')}
        control={<SettingsToggle disabled={!loaded} checked={preferences.notificationsEnabled && permission === 'granted'} label={t('settings.desktop_notifications')} onChange={() => void toggleNotifications()} />}
      />
      <div className="grid gap-2 rounded-lg border border-app-border-subtle bg-app-surface-sunken/20 p-3 sm:grid-cols-2">
        {([
          ['notifyCompleted', 'settings.desktop_notify_completed'],
          ['notifyFailed', 'settings.desktop_notify_failed'],
          ['notifyPaused', 'settings.desktop_notify_paused'],
          ['notifyAttention', 'settings.desktop_notify_attention'],
        ] as const).map(([key, label]) => (
          <label key={key} className={`flex items-center gap-2 text-xs text-app-text-secondary ${notificationControlsDisabled ? 'opacity-45' : ''}`}>
            <input type="checkbox" disabled={notificationControlsDisabled} checked={preferences[key]} onChange={() => void commit({ [key]: !preferences[key] })} className="accent-telegram-primary" />
            {t(label)}
          </label>
        ))}
      </div>
      <SettingsRow
        icon={<MonitorUp className="h-4 w-4 text-telegram-subtext" />}
        title={t('settings.desktop_notify_visible')}
        description={t('settings.desktop_notify_visible_desc')}
        control={<SettingsToggle disabled={notificationControlsDisabled} checked={preferences.notifyWhileVisible} label={t('settings.desktop_notify_visible')} onChange={() => void commit({ notifyWhileVisible: !preferences.notifyWhileVisible })} />}
      />
      <SettingsRow
        icon={<Eye className="h-4 w-4 text-telegram-subtext" />}
        title={t('settings.desktop_notification_filenames')}
        description={t('settings.desktop_notification_filenames_desc')}
        control={<SettingsToggle disabled={notificationControlsDisabled} checked={preferences.showFilenamesInNotifications} label={t('settings.desktop_notification_filenames')} onChange={() => void commit({ showFilenamesInNotifications: !preferences.showFilenamesInNotifications })} />}
      />
    </section>
  );
}
