import { useState } from 'react';
import { Lock, Unlock, ShieldAlert, ShieldX, AlertTriangle, Loader2 } from 'lucide-react';
import type { EncryptionState } from '../../types';
import { EncryptionTransparencyDialog } from './EncryptionTransparencyDialog';

interface EncryptionBadgeProps {
    state: EncryptionState;
    className?: string;
    showLabel?: boolean;
}

const stateConfig: Record<EncryptionState, { icon: typeof Lock; color: string; label: string }> = {
    plain: { icon: Lock, color: 'text-gray-400', label: 'Plain' },
    encrypted_unlocked: { icon: Unlock, color: 'text-emerald-400', label: 'Decrypted' },
    encrypted_locked: { icon: Lock, color: 'text-amber-400', label: 'Encrypted' },
    encrypted_key_missing: { icon: ShieldAlert, color: 'text-red-400', label: 'Key Missing' },
    encrypted_unsupported_version: { icon: ShieldX, color: 'text-red-400', label: 'Needs a newer app version' },
    encrypted_corrupt: { icon: AlertTriangle, color: 'text-red-500', label: 'Corrupt' },
    encrypted_verifying: { icon: Loader2, color: 'text-blue-400', label: 'Verifying' },
};

export function EncryptionBadge({ state, className = '', showLabel = false }: EncryptionBadgeProps) {
    const [showExplanation, setShowExplanation] = useState(false);
    const config = stateConfig[state];
    const Icon = config.icon;
    const isVerifying = state === 'encrypted_verifying';

    if (state === 'plain') {
        return null;
    }

    return (
        <>
        <button
            type="button"
            className={`inline-flex items-center gap-1 ${className}`}
            title={`${config.label} — learn why this file is protected`}
            aria-label={`${config.label}. Explain file protection`}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowExplanation(true); }}
        >
            <Icon
                className={`w-3.5 h-3.5 ${config.color} ${isVerifying ? 'animate-spin' : ''}`}
            />
            {showLabel && (
                <span className={`text-[10px] font-medium ${config.color}`}>
                    {config.label}
                </span>
            )}
        </button>
        {showExplanation && <EncryptionTransparencyDialog state={state} onClose={() => setShowExplanation(false)} />}
        </>
    );
}
