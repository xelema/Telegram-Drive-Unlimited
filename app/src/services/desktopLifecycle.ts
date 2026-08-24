import { invoke } from '@tauri-apps/api/core';

export type DesktopCloseBehavior = 'background' | 'quit';
export type NotificationPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

export interface DesktopPreferences {
  schemaVersion: number;
  backgroundModeEnabled: boolean;
  closeBehavior: DesktopCloseBehavior;
  notificationsEnabled: boolean;
  notifyCompleted: boolean;
  notifyFailed: boolean;
  notifyPaused: boolean;
  notifyAttention: boolean;
  notifyWhileVisible: boolean;
  showFilenamesInNotifications: boolean;
  backgroundHintSeen: boolean;
  lockOnSleep: boolean;
}

export interface DesktopNavigationRequest {
  target: 'home' | 'transfers' | 'settings' | 'authentication';
  transferId?: string;
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  schemaVersion: 1,
  backgroundModeEnabled: true,
  closeBehavior: 'background',
  notificationsEnabled: false,
  notifyCompleted: true,
  notifyFailed: true,
  notifyPaused: true,
  notifyAttention: true,
  notifyWhileVisible: false,
  showFilenamesInNotifications: false,
  backgroundHintSeen: false,
  lockOnSleep: true,
};

export function normalizeDesktopPreferences(
  value?: Partial<DesktopPreferences> | null,
): DesktopPreferences {
  const merged = { ...DEFAULT_DESKTOP_PREFERENCES, ...value };
  merged.schemaVersion = 1;
  if (merged.closeBehavior !== 'background' && merged.closeBehavior !== 'quit') {
    merged.closeBehavior = 'background';
  }
  return merged;
}

export async function getDesktopPreferences(): Promise<DesktopPreferences> {
  return normalizeDesktopPreferences(await invoke<Partial<DesktopPreferences>>('cmd_get_desktop_preferences'));
}

export async function updateDesktopPreferences(
  preferences: DesktopPreferences,
): Promise<DesktopPreferences> {
  return normalizeDesktopPreferences(await invoke<DesktopPreferences>('cmd_update_desktop_preferences', {
    preferences: normalizeDesktopPreferences(preferences),
  }));
}

export function getNotificationPermission(): Promise<NotificationPermission> {
  return invoke<NotificationPermission>('cmd_get_notification_permission');
}

export function requestNotificationPermission(): Promise<NotificationPermission> {
  return invoke<NotificationPermission>('cmd_request_notification_permission');
}

export function markDesktopFrontendReady(): Promise<void> {
  return invoke('cmd_desktop_frontend_ready');
}

export function markDesktopFrontendUnready(): Promise<void> {
  return invoke('cmd_desktop_frontend_unready');
}
