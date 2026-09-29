/**
 * Quiet Utility component metrics. Visual colors remain CSS semantic tokens so
 * runtime custom themes can adapt without rebuilding the application.
 */
export const quietMetrics = {
  controlHeight: { inline: 28, compact: 30, standard: 32, prominent: 36, touch: 44 },
  toolbarHeight: { desktop: 48, mobileMinimum: 60 },
  navigationRowHeight: { desktop: 32, touch: 56 },
  listRowHeight: { desktop: 40, touch: 56 },
  sidebarWidth: { collapsed: 52, expanded: 240 },
  fileGrid: { gap: 12, minimumCardWidth: 120, minimumCardHeight: 90 },
  dialogWidth: { compact: 440, standard: 720, settings: 920 },
  motionMs: { fast: 120, standard: 160, slow: 220 },
} as const;
