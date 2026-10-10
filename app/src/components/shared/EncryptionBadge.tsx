import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Lock, Unlock, ShieldAlert, ShieldX, AlertTriangle, Loader2 } from 'lucide-react';
import type { EncryptionState } from '../../types';
import { EncryptionTransparencyDialog } from './EncryptionTransparencyDialog';

interface EncryptionBadgeProps {
    state: EncryptionState;
    className?: string;
    showLabel?: boolean;
}

const stateConfig: Record<EncryptionState, { icon: typeof Lock; color: string; labelKey: string }> = {
    plain: { icon: Lock, color: 'text-gray-400', labelKey: 'workspace.protection_plain' },
    encrypted_unlocked: { icon: Unlock, color: 'text-emerald-400', labelKey: 'protection_labels.decrypted' },
    encrypted_locked: { icon: Lock, color: 'text-amber-400', labelKey: 'protection_labels.encrypted' },
    encrypted_key_missing: { icon: ShieldAlert, color: 'text-red-400', labelKey: 'protection_labels.key_missing' },
    encrypted_unsupported_version: { icon: ShieldX, color: 'text-red-400', labelKey: 'protection_labels.newer_version' },
    encrypted_corrupt: { icon: AlertTriangle, color: 'text-red-500', labelKey: 'protection_labels.corrupt' },
    encrypted_verifying: { icon: Loader2, color: 'text-blue-400', labelKey: 'protection_labels.verifying' },
};

export function EncryptionBadge({ state, className = '', showLabel = false }: EncryptionBadgeProps) {
    const { t } = useTranslation();
    const [showExplanation, setShowExplanation] = useState(false);
    const config = stateConfig[state];
    const Icon = config.icon;
    const label = t(config.labelKey);
    const isVerifying = state === 'encrypted_verifying';

    if (state === 'plain') {
        return null;
    }

    return (
        <>
        <button
            type="button"
            className={`inline-flex items-center gap-1 ${className}`}
            title={t('protection_labels.learn', { state: label })}
            aria-label={t('protection_labels.explain', { state: label })}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowExplanation(true); }}
        >
            <Icon
                className={`w-3.5 h-3.5 ${config.color} ${isVerifying ? 'animate-spin' : ''}`}
            />
            {showLabel && (
                <span className={`text-[10px] font-medium ${config.color}`}>
                    {label}
                </span>
            )}
        </button>
        {showExplanation && <EncryptionTransparencyDialog state={state} onClose={() => setShowExplanation(false)} />}
        </>
    );
}
