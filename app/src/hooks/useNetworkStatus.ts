import { useState, useEffect } from 'react';

/**
 * Network detection for Tauri apps using lightweight backend check
 * 
 * Uses cmd_is_network_available which does a simple TCP connection test
 * to Telegram servers without using grammers (avoids stack overflow).
 * 
 * Polls every 10 seconds - very lightweight (~2ms per check).
 */
export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(true);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        // Import Tauri invoke
        import('@tauri-apps/api/core').then(({ invoke }) => {
            // Check network status
            const checkNetwork = async () => {
                try {
                    // Use the lightweight TCP check (no grammers involved)
                    const available = await invoke<boolean>('cmd_is_network_available');
                    setIsOnline(available);
                } catch (error) {
                    // If the command fails, assume offline
                    setIsOnline(false);
                }
            };

            // Initial check
            checkNetwork();

            // Poll every 10 seconds (very lightweight, ~2ms per check)
            interval = setInterval(checkNetwork, 10000);
        });

        return () => {
            if (interval) clearInterval(interval);
        };
    }, []);

    return isOnline;
}
