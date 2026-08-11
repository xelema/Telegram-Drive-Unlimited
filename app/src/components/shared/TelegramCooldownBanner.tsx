import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { Clock3 } from 'lucide-react';

interface CooldownPayload {
    operation: string;
    retryAt: number;
    seconds: number;
    active: boolean;
}

export function TelegramCooldownBanner() {
    const [cooldown, setCooldown] = useState<CooldownPayload | null>(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!isTauri()) return;
        let dispose: (() => void) | undefined;
        let cancelled = false;
        void listen<CooldownPayload>('telegram-cooldown', ({ payload }) => {
            setCooldown(payload.active ? payload : null);
            setNow(Date.now());
        }).then((fn) => {
            if (cancelled) fn();
            else dispose = fn;
        }).catch(() => {
            // The banner is optional; a listener failure must never affect app startup.
        });
        return () => {
            cancelled = true;
            dispose?.();
        };
    }, []);

    useEffect(() => {
        if (!cooldown) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [cooldown]);

    const remaining = useMemo(() => cooldown ? Math.max(0, Math.ceil((cooldown.retryAt - now) / 1000)) : 0, [cooldown, now]);
    useEffect(() => {
        if (cooldown && remaining === 0) setCooldown(null);
    }, [cooldown, remaining]);
    if (!cooldown) return null;

    return (
        <div className="fixed left-1/2 top-3 z-[240] flex -translate-x-1/2 items-center gap-2 rounded-full border border-app-warning/25 bg-app-surface-raised px-4 py-2 text-sm text-app-text shadow-xl" role="status" aria-live="polite">
            <Clock3 className="h-4 w-4 text-app-warning" />
            <span>Telegram is cooling down. {cooldown.operation} resumes automatically in <strong className="tabular-nums">{remaining}s</strong>.</span>
        </div>
    );
}
