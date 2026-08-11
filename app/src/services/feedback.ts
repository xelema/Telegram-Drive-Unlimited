export type HapticTone = 'selection' | 'success' | 'warning' | 'error';

export function triggerHaptic(tone: HapticTone = 'selection') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const pattern: Record<HapticTone, number | number[]> = {
    selection: 8,
    success: [10, 35, 14],
    warning: [18, 40, 18],
    error: [24, 35, 24, 35, 24],
  };
  navigator.vibrate(pattern[tone]);
}

export function animateThemeChange() {
  if (typeof document === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.animate(
    [
      { opacity: 0.96, transform: 'scale(0.997)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' },
  );
}
