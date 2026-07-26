import { Lock, Unlock, ShieldAlert, ShieldX, AlertTriangle, Loader2 } from 'lucide-react';
import type { EncryptionState } from '../../types';

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
    encrypted_unsupported_version: { icon: ShieldX, color: 'text-red-400', label: 'Unsupported' },
    encrypted_corrupt: { icon: AlertTriangle, color: 'text-red-500', label: 'Corrupt' },
    encrypted_verifying: { icon: Loader2, color: 'text-blue-400', label: 'Verifying' },
};

export function EncryptionBadge({ state, className = '', showLabel = false }: EncryptionBadgeProps) {
    const config = stateConfig[state];
    const Icon = config.icon;
    const isVerifying = state === 'encrypted_verifying';

    if (state === 'plain') {
        return null;
    }

    return (
        <span
            className={`inline-flex items-center gap-1 ${className}`}
            title={config.label}
            role="img"
            aria-label={config.label}
        >
            <Icon
                className={`w-3.5 h-3.5 ${config.color} ${isVerifying ? 'animate-spin' : ''}`}
            />
            {showLabel && (
                <span className={`text-[10px] font-medium ${config.color}`}>
                    {config.label}
                </span>
            )}
        </span>
    );
}
