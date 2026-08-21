import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isAndroidPlatform } from '../utils';

/**
 * Network detection for Tauri apps using lightweight backend check
 * 
 * Desktop uses the existing lightweight Telegram TCP check. Android reads
 * ConnectivityManager state so Wi-Fi, cellular, VPN, and offline transitions
 * can pause recovery work before transport errors discard useful progress.
 */
export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(!isAndroidPlatform);

    useEffect(() => {
        let cancelled = false;
        const checkNetwork = async () => {
            try {
                const available = await invoke<boolean>(isAndroidPlatform
                    ? 'cmd_get_android_network_status'
                    : 'cmd_is_network_available');
                if (!cancelled) setIsOnline(available);
            } catch {
                if (!cancelled) setIsOnline(false);
            }
        };
        const handleOffline = () => {
            if (isAndroidPlatform) setIsOnline(false);
        };
        const handleOnline = () => void checkNetwork();
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') void checkNetwork();
        };

        void checkNetwork();
        const interval = window.setInterval(checkNetwork, isAndroidPlatform ? 2_000 : 10_000);
        if (isAndroidPlatform) {
            window.addEventListener('offline', handleOffline);
            window.addEventListener('online', handleOnline);
            document.addEventListener('visibilitychange', handleVisibility);
        }

        return () => {
            cancelled = true;
            window.clearInterval(interval);
            if (isAndroidPlatform) {
                window.removeEventListener('offline', handleOffline);
                window.removeEventListener('online', handleOnline);
                document.removeEventListener('visibilitychange', handleVisibility);
            }
        };
    }, []);

    return isOnline;
}
