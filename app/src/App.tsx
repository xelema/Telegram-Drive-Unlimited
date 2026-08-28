import React, { useState, useEffect, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { AppProviders } from "./components/shared/AppProviders";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { UpdateBanner } from "./components/shared/UpdateBanner";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { usePlatform } from "./hooks/usePlatform";
import "./App.css";

const DesktopDashboard = React.lazy(() => import("./components/desktop/DesktopDashboard").then(m => ({ default: m.Dashboard })));
const AuthWizard = React.lazy(() => import("./components/shared/AuthWizard").then(m => ({ default: m.AuthWizard })));
// Vite requires a fully static import path for dynamic imports so it can
// perform static analysis and code-splitting. Template literals with
// variables prevent Vite from resolving the module at build time.
const MobileDashboard = React.lazy(() => import("./components/mobile/MobileDashboard.tsx"));
const DesignGallery = import.meta.env.DEV
  ? React.lazy(() => import("./components/dev/DesignGallery"))
  : null;
const AccessibilityAudit = import.meta.env.DEV
  ? React.lazy(() => import("./components/dev/AccessibilityAudit"))
  : null;

import { Toaster, toast } from "sonner";
import { useTheme } from "./context/ThemeContext";
import { CrashReportingConsent } from "./components/shared/CrashReportingConsent";
import { configureCrashTelemetry } from "./services/crashTelemetry";
import { TelegramCooldownBanner } from "./components/shared/TelegramCooldownBanner";
import { WhatsNewDialog } from "./components/shared/WhatsNewDialog";
import { useSettings } from "./context/SettingsContext";
import { useTranslation } from "react-i18next";

import { getLanguageInfo } from "./i18n/languages";
import { resolveLanguagePreference } from "./i18n/resolveLanguage";
import { version as appVersion } from "../package.json";
import { consumeWhatsNew, type WhatsNewDetails } from "./services/updateReliability";
import { useTvSpatialNavigation } from "./hooks/useTvSpatialNavigation";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface StartupProgress {
  label: string;
  detail: string;
  percent: number;
}

function AppContent() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [startupProgress, setStartupProgress] = useState<StartupProgress>({
    label: "Starting Telegram Drive",
    detail: "Preparing local services…",
    percent: 8,
  });
  const [whatsNew, setWhatsNew] = useState<WhatsNewDetails | null>(() => consumeWhatsNew(appVersion));
  const { theme } = useTheme();
  const { available, version, downloading, progress, phase, downloadAndInstall, dismissUpdate } = useUpdateCheck();
  const { isMobile, isTelevision } = usePlatform();
  useTvSpatialNavigation(isTelevision);
  const { settings, updateSetting, isLoaded } = useSettings();
  const { i18n } = useTranslation();

  useEffect(() => {
    if (!isLoaded) return;
    configureCrashTelemetry(settings.crashReportingEnabled);
  }, [isLoaded, settings.crashReportingEnabled]);

  // Handle active language and RTL direction changes
  useEffect(() => {
    if (!isLoaded) return;
    const activeLang = resolveLanguagePreference(settings.language);
    const info = getLanguageInfo(activeLang);
    i18n.changeLanguage(activeLang);
    document.documentElement.lang = activeLang;
    document.documentElement.dir = info.dir;
  }, [settings.language, isLoaded, i18n]);

  // Performance mode: auto-enable when user has prefers-reduced-motion
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches && !settings.performanceMode) {
      updateSetting('performanceMode', true);
    }
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches && !settings.performanceMode) {
        updateSetting('performanceMode', true);
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Apply performance-mode class to body (guarded by settings load to avoid flicker)
  useEffect(() => {
    if (!isLoaded) return;
    if (settings.performanceMode) {
      document.body.classList.add('performance-mode');
    } else {
      document.body.classList.remove('performance-mode');
    }
  }, [settings.performanceMode, isLoaded]);

  useEffect(() => {
    document.documentElement.classList.toggle('tv-mode', isTelevision);
    return () => document.documentElement.classList.remove('tv-mode');
  }, [isTelevision]);

  // On mount: check for a saved session and auto-restore it.
  // This is the SINGLE source of truth for the initial connection.
  // useTelegramConnection (inside Dashboard) no longer calls cmd_connect on mount.
  useEffect(() => {
    const checkSession = async () => {
      try {
        setStartupProgress({ label: "Checking local services", detail: "Verifying the database and streaming runtime…", percent: 18 });
        await invoke("cmd_get_startup_health");
        setStartupProgress({ label: "Restoring your session", detail: "Reading the saved Telegram account…", percent: 38 });
        const store = await load("config.json");
        const savedId = await store.get<string>("api_id");

        if (!savedId) {
          setStartupProgress({ label: "Ready to sign in", detail: "No saved session was found.", percent: 100 });
          setAuthStatus("unauthenticated");
          return;
        }

        const apiId = parseInt(savedId, 10);
        if (isNaN(apiId)) {
          setStartupProgress({ label: "Ready to sign in", detail: "The saved session needs attention.", percent: 100 });
          setAuthStatus("unauthenticated");
          return;
        }

        // Initialize the client with the saved API ID
        setStartupProgress({ label: "Starting Telegram", detail: "Initializing the secure desktop client…", percent: 58 });
        await invoke("cmd_connect", { apiId });

        // Verify the session is still valid with Telegram servers
        setStartupProgress({ label: "Checking your account", detail: "Confirming the session with Telegram…", percent: 82 });
        const ok = await invoke<boolean>("cmd_check_connection");
        if (ok) {
          setStartupProgress({ label: "Opening your drive", detail: "Everything is ready.", percent: 100 });
          setAuthStatus("authenticated");
        } else {
          setAuthStatus("unauthenticated");
        }
      } catch (err) {
        console.warn("Session restore failed, showing login:", err);
        // Session file is corrupt or revoked — clean up and show login
        try {
          const store = await load("config.json");
          await store.delete("api_id");
          await store.save();
        } catch {
          // best-effort cleanup
        }
        setAuthStatus("unauthenticated");
      }
    };

    checkSession();
  }, []);

  // Show thank-you toast when user enters the app after clicking the ad
  useEffect(() => {
    if (authStatus !== "authenticated") return;

    const showThanks = async () => {
      try {
        const store = await load("config.json");
        const shouldThank = await store.get<boolean>("ad_click_thanks");
        if (shouldThank) {
          await store.delete("ad_click_thanks");
          await store.save();
          toast.success("Thanks for your support! ", {
            duration: 3000,
            style: {
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.1)",
            },
          });
        }
      } catch {
        // Non-critical
      }
    };

    // Small delay to let the dashboard finish mounting
    const timer = setTimeout(showThanks, 600);
    return () => clearTimeout(timer);
  }, [authStatus]);

  // Warm-up screen driven by actual Rust health and Telegram session steps.
  if (authStatus === "loading") {
    return (
      <main className="h-screen w-screen flex items-center justify-center bg-telegram-bg">
        <div className="flex w-full max-w-sm flex-col items-center gap-5 px-8" role="status" aria-live="polite">
          <img src="/logo.svg" className="w-16 h-16 drop-shadow-lg animate-pulse" alt="Telegram Drive" />
          <div className="w-full text-center">
            <p className="text-sm font-semibold text-telegram-text">{startupProgress.label}</p>
            <p className="mt-1 text-xs text-telegram-subtext">{startupProgress.detail}</p>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10" aria-label={`${startupProgress.percent}% complete`}>
            <div className="h-full rounded-full bg-telegram-primary transition-[width] duration-300" style={{ width: `${startupProgress.percent}%` }} />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="absolute inset-0 text-telegram-text overflow-hidden selection:bg-telegram-primary/30">
      <UpdateBanner
        available={available}
        version={version}
        downloading={downloading}
        progress={progress}
        phase={phase}
        onUpdate={downloadAndInstall}
        onDismiss={dismissUpdate}
      />
      <Toaster theme={theme} position="bottom-center" />
      <TelegramCooldownBanner />
      {whatsNew && <WhatsNewDialog details={whatsNew} onClose={() => setWhatsNew(null)} />}
      {isLoaded && <CrashReportingConsent />}
      {authStatus === "authenticated" && (
        <Suspense fallback={
          <div className="h-screen w-screen flex flex-col items-center justify-center bg-telegram-bg">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-telegram-primary"></div>
          </div>
        }>
          {isMobile ? (
            <ErrorBoundary>
              <MobileDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary>
              <DesktopDashboard onLogout={() => setAuthStatus("unauthenticated")} />
            </ErrorBoundary>
          )}
        </Suspense>
      )}
      {authStatus === "unauthenticated" && (
        <Suspense fallback={<div className="h-screen bg-telegram-bg" />}>
          <AuthWizard onLogin={() => setAuthStatus("authenticated")} />
        </Suspense>
      )}
    </main>
  );
}


function App() {
  const showDesignGallery = Boolean(
    DesignGallery && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('design-gallery')
  );

  return (
    <AppProviders>
      {AccessibilityAudit && (
        <Suspense fallback={null}><AccessibilityAudit /></Suspense>
      )}
      {showDesignGallery && DesignGallery ? (
        <Suspense fallback={<div className="h-screen bg-app-canvas" />}>
          <DesignGallery />
        </Suspense>
      ) : (
        <AppContent />
      )}
    </AppProviders>
  );
}

export default App;
