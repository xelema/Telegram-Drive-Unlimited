import { useState, useEffect } from 'react';
import { type } from '@tauri-apps/plugin-os';
import { invoke } from '@tauri-apps/api/core';

export function usePlatform() {
  const [platformInfo, setPlatformInfo] = useState({
    isMobile: false,
    isDesktop: true,
    isAndroid: false,
    isTelevision: false,
  });

  useEffect(() => {
    try {
      const osType = type();
      const isAndroid = osType === 'android';
      const isIos = osType === 'ios';
      const isMobile = isAndroid || isIos;

      setPlatformInfo({
        isMobile,
        isDesktop: !isMobile,
        isAndroid,
        isTelevision: false,
      });
      if (isAndroid) {
        const detectTelevision = async () => {
          for (const delay of [0, 400, 1_200]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            try {
              const environment = await invoke<{ isTelevision: boolean }>('cmd_get_android_transfer_environment');
              setPlatformInfo(current => ({ ...current, isTelevision: environment.isTelevision }));
              return;
            } catch {
              // JNI may still be warming up; retry on the next delay.
            }
          }
        };
        void detectTelevision();
      }
    } catch (e) {
      // Fallback for browser/development environments
      const ua = navigator.userAgent.toLowerCase();
      const isAndroid = ua.includes('android');
      const isMobile = isAndroid || ua.includes('iphone') || ua.includes('ipad');
      const isTelevision = isAndroid && /android tv|smart-tv|aft[a-z0-9]+|googletv/.test(ua);

      setPlatformInfo({
        isMobile,
        isDesktop: !isMobile,
        isAndroid,
        isTelevision,
      });
    }
  }, []);

  return platformInfo;
}
