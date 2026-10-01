import { useRef } from 'react';
import { AlertTriangle, KeyRound, ShieldCheck, X } from 'lucide-react';
import type { EncryptionState } from '../../types';
import { useModalFocus } from '../../hooks/useModalFocus';

interface EncryptionTransparencyDialogProps {
  onClose: () => void;
  state?: EncryptionState;
}

export function EncryptionTransparencyDialog({ onClose, state }: EncryptionTransparencyDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  const locked = state === 'encrypted_locked' || state === 'encrypted_key_missing';
  return (
    <div className="fixed inset-0 z-[290] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="protection-info-title" tabIndex={-1} className="quiet-raised w-[min(520px,calc(100vw-2rem))] overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><h2 id="protection-info-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><ShieldCheck className="h-5 w-5 text-app-accent" />{state ? 'Why is this file protected?' : 'How file protection works'}</h2><button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label="Close protection explanation"><X className="h-4 w-4" /></button></header>
        <div className="space-y-4 p-5 text-sm leading-6 text-app-text-secondary">
          {state && <p className="rounded-lg border border-app-border-subtle bg-app-surface-sunken/30 p-3"><strong className="text-app-text">Current state:</strong> {locked ? 'The file is protected and its key is not currently available.' : state === 'encrypted_corrupt' ? 'Integrity verification failed. The app will not return unauthenticated bytes.' : 'The file is protected and its key is currently available for this session.'}</p>}
          <div className="flex gap-3"><KeyRound className="mt-1 h-4 w-4 shrink-0 text-app-accent" /><p>Protection happens on this device before upload. Telegram stores an authenticated encrypted envelope rather than the original file bytes.</p></div>
          <div className="flex gap-3"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-app-success" /><p>The app verifies integrity before presenting plaintext. Vault keys remain local and can be automatically locked.</p></div>
          <div className="flex gap-3 rounded-lg border border-app-warning/20 bg-app-warning/5 p-3"><AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-app-warning" /><p><strong className="text-app-text">Limitations:</strong> Telegram cannot recover your key. Protected previews, streaming, third-party WebDAV clients, and share recipients may require the vault to be unlocked or a separate password link.</p></div>
        </div>
        <footer className="flex justify-end border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onClose} className="quiet-control bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">Understood</button></footer>
      </div>
    </div>
  );
}
