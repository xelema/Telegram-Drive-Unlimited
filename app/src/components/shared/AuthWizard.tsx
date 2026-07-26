import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Key, Lock, ArrowRight, Settings, ShieldCheck, Sun, Moon, HelpCircle, ExternalLink, X, Heart, QrCode } from "lucide-react";
import { load } from '@tauri-apps/plugin-store';
import { useTheme } from '../../context/ThemeContext';
import { open } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';

import { useTranslation } from "react-i18next";

type Step = "setup" | "phone" | "code" | "password";

function AuthThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            onClick={toggleTheme}
            className="quiet-control absolute end-4 top-[calc(1rem+env(safe-area-inset-top,24px))] z-10 flex h-9 w-9 items-center justify-center border border-app-border bg-app-surface-raised text-app-text-secondary shadow-[var(--shadow-raised)] hover:text-app-text"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
            {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
            ) : (
                <Moon className="h-4 w-4" />
            )}
        </button>
    );
}
export function AuthWizard({ onLogin }: { onLogin: () => void }) {
    const { t } = useTranslation();
    const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

    if (isBrowser) {
        return (
            <div className="auth-gradient flex h-full items-center justify-center p-6 text-center text-app-text">
              <div className="quiet-raised max-w-md p-6">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                    <ShieldCheck className="h-6 w-6 text-app-danger" />
                </div>
                <h1 className="text-app-title font-semibold text-app-text">{t('auth.desktop_required')}</h1>
                <p className="mx-auto mt-2 max-w-sm text-ui leading-relaxed text-app-text-secondary">
                    {t('auth.desktop_required_desc')}
                </p>
                <div className="mt-5 rounded-control border border-app-border bg-app-surface-sunken/40 p-3 text-metadata text-app-text-secondary">
                    {t('auth.open_window_prompt')}
                </div>
              </div>
            </div>
        )
    }

    const [step, setStep] = useState<Step>("setup");
    const [loading, setLoading] = useState(false);

    const [apiId, setApiId] = useState("");
    const [apiHash, setApiHash] = useState("");

    const [phone, setPhone] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [floodWait, setFloodWait] = useState<number | null>(null);
    const [showHelp, setShowHelp] = useState(false);
    const [showDonate, setShowDonate] = useState(false);
    const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>('phone');
    const isMobile = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());

    useEffect(() => {
        if (isMobile && loginMethod !== 'phone') {
            setLoginMethod('phone');
        }
    }, [isMobile, loginMethod]);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrPolling, setQrPolling] = useState(false);
    const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);


    useEffect(() => {
        if (!floodWait) return;
        const interval = setInterval(() => {
            setFloodWait(prev => {
                if (prev === null || prev <= 1) return null;
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [floodWait]);

    useEffect(() => {
        const initStore = async () => {
            try {
                const store = await load('config.json');
                const savedId = await store.get<string>('api_id');
                const savedHash = await store.get<string>('api_hash');

                if (savedId && savedHash) {
                    setApiId(savedId);
                    setApiHash(savedHash);
                }
            } catch {
                // config not found, starting fresh
            }
        };
        initStore();
    }, []);

    const saveCredentials = async () => {
        try {
            const store = await load('config.json');
            await store.set('api_id', apiId);
            await store.set('api_hash', apiHash);
            await store.save();
        } catch {
            // store write failure, non-critical
        }
    };

    const handleSetupSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (apiId.includes(' ') || apiHash.includes(' ')) {
            setError("API ID and API Hash cannot contain spaces. Please remove any spaces.");
            return;
        }

        if (!apiId || !apiHash) {
            setError("Both API ID and Hash are required.");
            return;
        }
        setError(null);
        await saveCredentials();
        setStep("phone");
        setLoginMethod('phone');
        setQrUrl(null);
        setQrPolling(false);
    };

    const handleQrLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");

            const url = await invoke<string>("cmd_auth_qr_login", {
                apiId: idInt,
                apiHash: apiHash
            });

            if (url === "__authorized__") {
                onLogin();
                return;
            }

            setQrUrl(url);
            setQrPolling(true);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    // QR polling effect
    useEffect(() => {
        if (!qrPolling) {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
            return;
        }

        qrPollRef.current = setInterval(async () => {
            try {
                const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_qr_poll");
                if (res.success) {
                    setQrPolling(false);
                    if (res.next_step === "password") {
                        setStep("password");
                    } else {
                        onLogin();
                    }
                }
                // If next_step === "waiting", keep polling
            } catch {
                // Polling error — keep trying silently
            }
        }, 3000);

        return () => {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
        };
    }, [qrPolling, apiId, apiHash]);

    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");

            await invoke("cmd_auth_request_code", {
                phone,
                apiId: idInt,
                apiHash: apiHash
            });
            setStep("code");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : JSON.stringify(err);
            if (msg.includes("FLOOD_WAIT_")) {
                const parts = msg.split("FLOOD_WAIT_");
                if (parts[1]) {
                    const seconds = parseInt(parts[1]);
                    if (!isNaN(seconds)) {
                        setFloodWait(seconds);
                        return;
                    }
                }
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (res.success) {
                onLogin();
            } else if (res.next_step === "password") {
                setStep("password");
            } else {
                setError("Unknown error");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (res.success) {
                onLogin();
            } else {
                setError("Password verification failed.");
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-gradient relative flex h-full w-full items-center justify-center overflow-y-auto p-4 pt-[calc(1rem+env(safe-area-inset-top,24px))] text-app-text sm:p-6">
            <AuthThemeToggle />

            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="auth-glass my-auto w-full max-w-[26rem] rounded-overlay p-5 sm:p-6"
            >
                <div className="mb-6 text-center">
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center">
                        <img src="/logo.svg" alt="Logo" className="w-full h-full" />
                    </div>
                    <h1 className="text-app-title font-semibold tracking-[-0.01em] text-app-text">Telegram Drive</h1>
                    <p className="mt-1 text-metadata text-app-text-secondary">Self-hosted secure storage</p>
                </div>

                <AnimatePresence mode="wait">
                    {floodWait ? (
                        <motion.div
                            key="flood"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="space-y-5 text-center"
                        >
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-container bg-app-danger/10">
                                <span className="text-xl">⏳</span>
                            </div>
                            <div>
                                <h2 className="text-app-title font-semibold text-app-text">Too Many Requests</h2>
                                <p className="mt-2 text-ui text-app-text-secondary">Telegram has temporarily limited your actions.</p>
                                <p className="text-ui text-app-text-secondary">Please wait before trying again.</p>
                            </div>

                            <div className="flex items-center justify-center font-mono text-3xl font-semibold tabular-nums text-app-accent">
                                {Math.floor(floodWait / 60)}:{(floodWait % 60).toString().padStart(2, '0')}
                            </div>

                            <p className="mt-4 text-metadata text-app-danger">
                                Do not restart the app. The timer will reset if you do.
                            </p>
                        </motion.div>
                    ) : (
                        <>


                            {step === "setup" && (
                                <motion.form
                                    key="setup"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleSetupSubmit}
                                    className="space-y-4"
                                >
                                    <div className="space-y-3">
                                        <div>
                                            <label className="auth-label">API ID</label>
                                            <div className="relative">
                                                <Key className="auth-input-icon" />
                                                <input
                                                    type="text"
                                                    value={apiId}
                                                    onChange={(e) => setApiId(e.target.value)}
                                                    placeholder="12345678"
                                                    className="auth-input font-mono"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="auth-label">API Hash</label>
                                            <div className="relative">
                                                <Key className="auth-input-icon" />
                                                <input
                                                    type="text"
                                                    value={apiHash}
                                                    onChange={(e) => setApiHash(e.target.value)}
                                                    placeholder="abcdef123456..."
                                                    className="auth-input font-mono"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        className="quiet-control auth-primary-action"
                                    >
                                        Configure <Settings className="w-4 h-4" />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setShowHelp(true)}
                                        className="quiet-control auth-secondary-action w-full"
                                    >
                                        <HelpCircle className="w-3 h-3" />
                                        How do I get my API credentials?
                                    </button>

                                    {import.meta.env.DEV && (
                                        <button
                                            type="button"
                                            onClick={() => onLogin()}
                                            className="quiet-control auth-secondary-action w-full text-app-danger"
                                        >
                                            Dev Mode
                                        </button>
                                    )}
                                </motion.form>
                            )}


                            {step === "phone" && (
                                <motion.div
                                    key="phone"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    className="space-y-5"
                                >
                                    {/* Phone / QR Toggle */}
                                    {!isMobile && (
                                        <div className="quiet-control flex overflow-hidden border border-app-border bg-app-surface-sunken/40 p-0.5">
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('phone'); setQrUrl(null); setQrPolling(false); setError(null); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'phone'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <Phone className="w-4 h-4" /> Phone Number
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMethod('qr'); setError(null); handleQrLogin(); }}
                                                className={`quiet-control flex h-8 flex-1 items-center justify-center gap-2 text-metadata font-medium ${
                                                    loginMethod === 'qr'
                                                        ? 'bg-app-surface-raised text-app-text shadow-sm'
                                                        : 'text-app-text-secondary hover:text-app-text'
                                                }`}
                                            >
                                                <QrCode className="w-4 h-4" /> QR Code
                                            </button>
                                        </div>
                                    )}

                                    {loginMethod === 'phone' ? (
                                        <form onSubmit={handlePhoneSubmit} className="space-y-5">
                                            <div className="space-y-2">
                                                <label className="auth-label">Phone Number</label>
                                                <div className="relative">
                                                    <Phone className="auth-input-icon" />
                                                    <input
                                                        type="tel"
                                                        value={phone}
                                                        onChange={(e) => setPhone(e.target.value)}
                                                        placeholder="+1 234 567 8900"
                                                        className="auth-input tracking-wide"
                                                    />
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-3">
                                                <button
                                                    type="submit"
                                                    disabled={loading}
                                                    className="quiet-control auth-primary-action disabled:opacity-45"
                                                >
                                                    {loading ? "Connecting..." : <>Continue <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>}
                                                </button>
                                                <button type="button" onClick={() => setStep("setup")} className="quiet-control auth-secondary-action w-full">
                                                    Back to Configuration
                                                </button>
                                            </div>
                                        </form>
                                    ) : (
                                        <div className="flex flex-col items-center gap-5">
                                            {loading && !qrUrl && (
                                                <div className="flex h-52 w-52 items-center justify-center rounded-container bg-app-surface-sunken/45">
                                                    <div className="h-7 w-7 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                </div>
                                            )}
                                            {qrUrl && (
                                                <>
                                                    <div className="rounded-container bg-white p-3 shadow-[var(--shadow-raised)]">
                                                        <QRCodeSVG
                                                            value={qrUrl}
                                                            size={200}
                                                            level="M"
                                                            bgColor="#ffffff"
                                                            fgColor="#000000"
                                                        />
                                                    </div>
                                                    <div className="text-center space-y-1">
                                                        <p className="text-ui text-app-text">Scan with your Telegram app</p>
                                                        <p className="text-metadata text-app-text-tertiary">Settings &gt; Devices &gt; Link Desktop Device</p>
                                                    </div>
                                                    {qrPolling && (
                                                        <div className="flex items-center gap-2 text-metadata text-app-accent">
                                                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
                                                            Waiting for scan...
                                                        </div>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={handleQrLogin}
                                                        className="quiet-control auth-secondary-action px-2"
                                                    >
                                                        Refresh QR Code
                                                    </button>
                                                </>
                                            )}
                                            <button type="button" onClick={() => { setStep("setup"); setQrPolling(false); }} className="quiet-control auth-secondary-action w-full">
                                                Back to Configuration
                                            </button>
                                        </div>
                                    )}
                                </motion.div>
                            )}


                            {step === "code" && (
                                <motion.form
                                    key="code"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleCodeSubmit}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <label className="auth-label">Telegram Code</label>
                                        <div className="relative">
                                            <Key className="auth-input-icon" />
                                            <input
                                                type="text"
                                                value={code}
                                                onChange={(e) => setCode(e.target.value)}
                                                placeholder="1 2 3 4 5"
                                                className="auth-input pe-3 ps-10 text-center font-mono text-base tracking-[0.4em]"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Sign In"}
                                        </button>
                                        <button type="button" onClick={() => setStep("phone")} className="quiet-control auth-secondary-action w-full">
                                            Change Phone Number
                                        </button>
                                    </div>
                                </motion.form>
                            )}


                            {step === "password" && (
                                <motion.form
                                    key="password"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handlePasswordSubmit}
                                    className="space-y-5"
                                >
                                    <div className="space-y-2">
                                        <div className="mb-4 rounded-control border border-app-accent/20 bg-app-selected p-3">
                                            <p className="text-center text-metadata text-app-accent">
                                                Your account has Two-Factor Authentication enabled.
                                                Please enter your cloud password to continue.
                                            </p>
                                        </div>
                                        <label className="auth-label">Cloud Password</label>
                                        <div className="relative">
                                            <Lock className="auth-input-icon" />
                                            <input
                                                type="password"
                                                value={password}
                                                onChange={(e) => setPassword(e.target.value)}
                                                placeholder="Enter your password"
                                                className="auth-input"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-3">
                                        <button
                                            type="submit"
                                            disabled={loading || !password}
                                            className="quiet-control auth-primary-action disabled:opacity-45"
                                        >
                                            {loading ? "Verifying..." : "Unlock"}
                                        </button>
                                        <button type="button" onClick={() => { setStep("code"); setPassword(""); setError(null); }} className="quiet-control auth-secondary-action w-full">
                                            Back to Code Entry
                                        </button>
                                    </div>
                                </motion.form>
                            )}
                        </>
                    )}
                </AnimatePresence>

                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-5 flex items-start gap-2 rounded-control border border-app-danger/20 bg-app-danger/10 p-3"
                    >
                        <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                        <p className="text-ui leading-snug text-app-danger">{error}</p>
                    </motion.div>
                )}

                <div className="mt-6 border-t border-app-border-subtle pt-3 text-center">
                    <button
                        onClick={() => setShowDonate(true)}
                        className="quiet-control auth-secondary-action mx-auto px-2"
                    >
                        <Heart className="w-3.5 h-3.5 text-red-500/80" />
                        Donate
                    </button>
                </div>
            </motion.div>


            <AnimatePresence>
                {showHelp && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm"
                        onClick={() => setShowHelp(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="quiet-raised max-h-[80vh] w-full max-w-lg overflow-y-auto p-5 sm:p-6"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-5 flex items-center justify-between">
                                <h2 className="text-app-title font-semibold text-app-text">Getting Started</h2>
                                <button onClick={() => setShowHelp(false)} className="quiet-control flex h-8 w-8 items-center justify-center text-app-text-secondary hover:text-app-text" aria-label="Close help">
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="space-y-5 text-app-text">
                                <div className="rounded-control border border-app-accent/20 bg-app-selected p-3">
                                    <p className="text-ui leading-relaxed text-app-text-secondary">
                                        <strong className="text-app-accent">Telegram Drive</strong> uses your Telegram account as secure cloud storage. You'll need a Telegram account and API credentials to get started.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">1</span>
                                        Go to Telegram's Developer Portal
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        Visit <button type="button" onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }} className="cursor-pointer text-app-accent underline hover:text-app-text">my.telegram.org</button> and log in with your phone number.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">2</span>
                                        Create a New Application
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        Click on <strong>"API development tools"</strong> and create a new application. Use any name and description you like.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-ui font-semibold">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-app-accent text-badge font-semibold text-app-accent-contrast">3</span>
                                        Copy Your Credentials
                                    </h3>
                                    <p className="ms-7 text-ui leading-relaxed text-app-text-secondary">
                                        After creating the app, you'll see your <strong>API ID</strong> (a number) and <strong>API Hash</strong> (a string). Copy both and paste them into the fields on the previous screen.
                                    </p>
                                </div>

                                <div className="rounded-control border border-app-border bg-app-surface-sunken/35 p-3">
                                    <p className="text-metadata leading-relaxed text-app-text-secondary">
                                        <strong>🔒 Privacy:</strong> Your credentials are stored locally on your device and are never sent to any third-party servers. All data goes directly between you and Telegram.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }}
                                    className="quiet-control auth-primary-action"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open my.telegram.org
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showDonate && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm"
                        onClick={() => setShowDonate(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="quiet-raised w-full max-w-sm p-5"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative mb-5 flex items-center justify-center">
                                <h2 className="text-center text-app-title font-semibold text-app-text">
                                    Support the Project
                                </h2>
                                <button onClick={() => setShowDonate(false)} className="quiet-control absolute end-0 flex h-8 w-8 items-center justify-center text-app-text-secondary hover:text-app-text" aria-label="Close donation options">
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="space-y-4 text-center">
                                <p className="mb-5 text-ui leading-relaxed text-app-text-secondary">
                                    If you find Telegram Drive useful, consider supporting its development!
                                </p>

                                <div className="space-y-4">
                                    <a href="#" onClick={(e) => { e.preventDefault(); open('https://www.paypal.me/Caamer20'); }} className="block hover:opacity-80 transition-opacity">
                                        <img src="https://raw.githubusercontent.com/stefan-niedermann/paypal-donate-button/master/paypal-donate-button.png" alt="Donate with PayPal" width="200" className="mx-auto" />
                                    </a>

                                    <a href="#" onClick={(e) => { e.preventDefault(); open('https://link.trustwallet.com/send?address=ltc1q6wkr5ac4u0pxx4hx7xgwn0gsaku25ws0df73rp&asset=c2'); }} className="block hover:opacity-80 transition-opacity">
                                        <img src="https://img.shields.io/badge/Donate-LTC-345D9D?style=for-the-badge&logo=litecoin&logoColor=white" alt="Donate LTC" className="mx-auto h-[28px]" />
                                    </a>

                                    <a href="#" onClick={(e) => { e.preventDefault(); open('https://link.trustwallet.com/send?asset=c0&address=bc1q5pt7m2fk6w0dzsnf6vvd5k6nw5k44785286ujy'); }} className="block hover:opacity-80 transition-opacity">
                                        <img src="https://img.shields.io/badge/Donate-BTC-F7931A?style=for-the-badge&logo=bitcoin&logoColor=white" alt="Donate BTC" className="mx-auto h-[28px]" />
                                    </a>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

        </div>
    );
}
