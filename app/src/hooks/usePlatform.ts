import { useState, useEffect } from 'react';
import { type } from '@tauri-apps/plugin-os';

export function usePlatform() {
  const [platformInfo, setPlatformInfo] = useState({
    isMobile: false,
    isDesktop: true,
    isAndroid: false,
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
      });
    } catch (e) {
      // Fallback for browser/development environments
      const ua = navigator.userAgent.toLowerCase();
      const isAndroid = ua.includes('android');
      const isMobile = isAndroid || ua.includes('iphone') || ua.includes('ipad');

      setPlatformInfo({
        isMobile,
        isDesktop: !isMobile,
        isAndroid,
      });
    }
  }, []);

  return platformInfo;
}
