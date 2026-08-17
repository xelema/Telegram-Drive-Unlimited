import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, Sun, Moon, ExternalLink, X, Heart } from "lucide-react";
import { load } from '@tauri-apps/plugin-store';
import { useTheme } from '../../context/ThemeContext';
import { open } from '@tauri-apps/plugin-shell';
import {
    AuthCodeStep,
    AuthMethodStep,
    AuthPasswordStep,
    AuthSetupStep,
    type AuthStep,
    type CodeRequestResult,
} from './auth/AuthSteps';

import { useTranslation } from "react-i18next";

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

    const [step, setStep] = useState<AuthStep>("setup");
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
    const isMobile = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase());
    const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>(() => isMobile ? 'phone' : 'qr');
    const [codeDelivery, setCodeDelivery] = useState<CodeRequestResult | null>(null);
    const [resendWait, setResendWait] = useState(0);

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
        if (resendWait <= 0) return;
        const interval = setInterval(() => {
            setResendWait((previous) => Math.max(0, previous - 1));
        }, 1000);
        return () => clearInterval(interval);
    }, [resendWait]);

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
        setLoginMethod(isMobile ? 'phone' : 'qr');
        setQrUrl(null);
        setQrPolling(false);
        if (!isMobile) void handleQrLogin();
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

    const applyCodeRequestResult = (codeRequest: CodeRequestResult) => {
        if (codeRequest.status === "authorized") {
            onLogin();
            return;
        }

        setCode("");
        setCodeDelivery(codeRequest);
        setResendWait(Math.max(0, codeRequest.resendAfterSeconds ?? 0));
        setStep("code");
    };

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
                const pollResult = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_qr_poll");
                if (pollResult.success) {
                    setQrPolling(false);
                    if (pollResult.next_step === "password") {
                        setStep("password");
                    } else {
                        onLogin();
                    }
                }
            } catch {
                // Telegram may briefly reject a poll while rotating the QR token.
            }
        }, 3000);

        return () => {
            if (qrPollRef.current) {
                clearInterval(qrPollRef.current);
                qrPollRef.current = null;
            }
        };
    }, [qrPolling, apiId, apiHash]);

    const handleAuthError = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const floodMatch = message.match(/FLOOD_WAIT_(\d+)/);
        if (floodMatch) {
            setFloodWait(Number.parseInt(floodMatch[1], 10));
            return;
        }
        setError(message);
    };

    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");

            const codeRequest = await invoke<CodeRequestResult>("cmd_auth_request_code", {
                phone,
                apiId: idInt,
                apiHash: apiHash
            });
            applyCodeRequestResult(codeRequest);
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const signInResult = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (signInResult.success) {
                onLogin();
            } else if (signInResult.next_step === "password") {
                setStep("password");
            } else {
                setError("Unknown error");
            }
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const passwordResult = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (passwordResult.success) {
                onLogin();
            } else {
                setError("Password verification failed.");
            }
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleResendCode = async () => {
        if (resendWait > 0 || loading) return;
        setLoading(true);
        setError(null);
        try {
            const codeRequest = await invoke<CodeRequestResult>("cmd_auth_resend_code");
            applyCodeRequestResult(codeRequest);
        } catch (err: unknown) {
            handleAuthError(err);
        } finally {
            setLoading(false);
        }
    };

    const handleChangePhone = async () => {
        try {
            await invoke("cmd_auth_cancel_code");
        } catch {
            // Cancellation is best-effort; local backend state is always cleared.
        }
        setCode("");
        setCodeDelivery(null);
        setResendWait(0);
        setError(null);
        setStep("phone");
    };

    const handleUseQrInstead = () => {
        setCode("");
        setCodeDelivery(null);
        setResendWait(0);
        setError(null);
        setStep("phone");
        setLoginMethod("qr");
        setQrUrl(null);
        setQrPolling(false);
        void handleQrLogin();
    };

    const handleOpenFragment = async () => {
        if (!codeDelivery?.fragmentUrl) return;
        try {
            const target = new URL(codeDelivery.fragmentUrl);
            const isFragment = target.protocol === "https:"
                && (target.hostname === "fragment.com" || target.hostname.endsWith(".fragment.com"));
            if (!isFragment) throw new Error("Invalid Fragment login URL");
            await open(target.toString());
        } catch {
            setError(t("auth.fragment_url_invalid"));
        }
    };

    const deliveryMessage = (() => {
        if (!codeDelivery) return "";
        const hint = codeDelivery.destinationHint ?? "";
        switch (codeDelivery.delivery) {
            case "telegram_app": return t("auth.code_sent_telegram_app");
            case "sms": return t("auth.code_sent_sms");
            case "call": return t("auth.code_sent_call");
            case "flash_call": return t("auth.code_sent_flash_call", { hint });
            case "missed_call": return t("auth.code_sent_missed_call", { hint });
            case "email": return t("auth.code_sent_email", { hint });
            case "fragment": return t("auth.code_sent_fragment");
            case "sms_word": return t("auth.code_sent_sms_word", { hint });
            case "sms_phrase": return t("auth.code_sent_sms_phrase", { hint });
            case "email_setup":
            case "firebase":
            default: return t("auth.code_delivery_unsupported");
        }
    })();

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
                                <AuthSetupStep
                                    apiId={apiId}
                                    apiHash={apiHash}
                                    isMobile={isMobile}
                                    onApiIdChange={setApiId}
                                    onApiHashChange={setApiHash}
                                    onSubmit={handleSetupSubmit}
                                    onShowHelp={() => setShowHelp(true)}
                                    onDevLogin={onLogin}
                                />
                            )}
                            {step === "phone" && (
                                <AuthMethodStep
                                    isMobile={isMobile}
                                    loginMethod={loginMethod}
                                    loading={loading}
                                    phone={phone}
                                    qrUrl={qrUrl}
                                    qrPolling={qrPolling}
                                    onPhoneChange={setPhone}
                                    onSelectPhone={() => { setLoginMethod("phone"); setQrUrl(null); setQrPolling(false); setError(null); }}
                                    onSelectQr={() => { setLoginMethod("qr"); setError(null); void handleQrLogin(); }}
                                    onPhoneSubmit={handlePhoneSubmit}
                                    onQrLogin={() => { void handleQrLogin(); }}
                                    onBack={() => { setStep("setup"); if (loginMethod === "qr") setQrPolling(false); }}
                                />
                            )}
                            {step === "code" && (
                                <AuthCodeStep
                                    codeDelivery={codeDelivery}
                                    deliveryMessage={deliveryMessage}
                                    code={code}
                                    loading={loading}
                                    resendWait={resendWait}
                                    isMobile={isMobile}
                                    onCodeChange={setCode}
                                    onSubmit={handleCodeSubmit}
                                    onOpenFragment={() => { void handleOpenFragment(); }}
                                    onResend={() => { void handleResendCode(); }}
                                    onUseQr={handleUseQrInstead}
                                    onChangePhone={() => { void handleChangePhone(); }}
                                />
                            )}
                            {step === "password" && (
                                <AuthPasswordStep
                                    password={password}
                                    loading={loading}
                                    onPasswordChange={setPassword}
                                    onSubmit={handlePasswordSubmit}
                                    onBack={() => { setStep("code"); setPassword(""); setError(null); }}
                                />
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
                                    If you find Telegram Drive useful, the optional $5 USD Lifetime Ad-Free Supporter License is available after sign-in in Settings → Privacy. It removes desktop sponsor placements without locking any features behind payment. Only that verified in-app PayPal checkout activates ad-free access.
                                </p>

                                <div className="space-y-4">
                                    <a href="#" onClick={(e) => { e.preventDefault(); open('https://link.trustwallet.com/send?address=ltc1q6wkr5ac4u0pxx4hx7xgwn0gsaku25ws0df73rp&asset=c2'); }} className="block hover:opacity-80 transition-opacity">
                                        <img src="https://img.shields.io/badge/Donate-LTC-345D9D?style=for-the-badge&logo=litecoin&logoColor=white" alt="Donate LTC" className="mx-auto h-[28px]" />
                                    </a>

                                    <a href="#" onClick={(e) => { e.preventDefault(); open('https://link.trustwallet.com/send?asset=c0&address=bc1q5pt7m2fk6w0dzsnf6vvd5k6nw5k44785286ujy'); }} className="block hover:opacity-80 transition-opacity">
                                        <img src="https://img.shields.io/badge/Donate-BTC-F7931A?style=for-the-badge&logo=bitcoin&logoColor=white" alt="Donate BTC" className="mx-auto h-[28px]" />
                                    </a>
                                    <p className="text-metadata leading-5 text-app-text-tertiary">Cryptocurrency tips are optional donations and do not activate ad-free access. Refund availability depends on the payment method and applicable law.</p>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

        </div>
    );
}
