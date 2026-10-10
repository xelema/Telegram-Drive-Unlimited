import {useTranslation} from 'react-i18next';
import i18n from '../../i18n';
import { useRef } from 'react';
import { AlertTriangle, KeyRound, ShieldCheck, X } from 'lucide-react';
import type { EncryptionState } from '../../types';
import { useModalFocus } from '../../hooks/useModalFocus';

interface EncryptionTransparencyDialogProps {
  onClose: () => void;
  state?: EncryptionState;
}

export function EncryptionTransparencyDialog({ onClose, state }: EncryptionTransparencyDialogProps) {
    useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  const locked = state === 'encrypted_locked' || state === 'encrypted_key_missing';
  return (
    <div className="fixed inset-0 z-[290] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="protection-info-title" tabIndex={-1} className="quiet-raised w-[min(520px,calc(100vw-2rem))] overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><h2 id="protection-info-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><ShieldCheck className="h-5 w-5 text-app-accent" />{state ? i18n.t('protection_copy.why') : i18n.t('protection_copy.how')}</h2><button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label={i18n.t('protection_copy.close')}><X className="h-4 w-4" /></button></header>
        <div className="space-y-4 p-5 text-sm leading-6 text-app-text-secondary">
          {state && <p className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/30 p-3"><strong className="text-app-text">{i18n.t('protection_copy.current')}</strong> {locked ? i18n.t('protection_copy.locked') : state === 'encrypted_corrupt' ? i18n.t('protection_copy.corrupt') : i18n.t('protection_copy.unlocked')}</p>}
          <div className="flex gap-3"><KeyRound className="mt-1 h-4 w-4 shrink-0 text-app-accent" /><p>{i18n.t('protection_copy.before_upload')}</p></div>
          <div className="flex gap-3"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-app-success" /><p>{i18n.t('protection_copy.integrity')}</p></div>
          <div className="flex gap-3 rounded-lg border border-app-warning/20 bg-app-warning/5 p-3"><AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-app-warning" /><p><strong className="text-app-text">{i18n.t('protection_copy.limitations')}</strong> {i18n.t('protection_copy.recovery_warning')}</p></div>
        </div>
        <footer className="flex justify-end border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onClose} className="quiet-control bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">{i18n.t('ui_copy.understood')}</button></footer>
      </div>
    </div>
  );
}
