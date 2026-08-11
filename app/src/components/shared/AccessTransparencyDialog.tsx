import { useRef } from 'react';
import { AlertTriangle, KeyRound, Network, ShieldCheck, X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';

export type LocalAccessService = 'webdav' | 'rest';

export function AccessTransparencyDialog({ service, onClose }: { service: LocalAccessService; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  const isWebDav = service === 'webdav';

  return (
    <div className="fixed inset-0 z-[290] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="local-access-title" tabIndex={-1} className="quiet-raised w-[min(540px,calc(100vw-2rem))] overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
          <h2 id="local-access-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><Network className="h-5 w-5 text-app-accent" aria-hidden="true" />{isWebDav ? 'How WebDAV access works' : 'How REST access works'}</h2>
          <button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label="Close local access explanation"><X className="h-4 w-4" aria-hidden="true" /></button>
        </header>
        <div className="space-y-4 p-5 text-sm leading-6 text-app-text-secondary">
          <div className="flex gap-3"><Network className="mt-1 h-4 w-4 shrink-0 text-app-accent" aria-hidden="true" /><p>The server runs on this device and port only after you enable it. Network and firewall rules determine which other devices can reach that address.</p></div>
          <div className="flex gap-3"><KeyRound className="mt-1 h-4 w-4 shrink-0 text-app-warning" aria-hidden="true" /><p>{isWebDav ? 'The complete /dav/<token>/ URL is the credential. Guest or anonymous login without that token has no access.' : 'Every request must provide the generated API key. Regenerating it immediately revokes clients using the previous key.'}</p></div>
          <div className="flex gap-3"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-app-success" aria-hidden="true" /><p>{isWebDav ? 'Read-only mode permits browsing and downloads. “Allow file changes” additionally permits uploads, moves, renames, and deletes.' : 'REST clients can automate the documented file operations available to the local API. Disable the server when the integration is no longer needed.'}</p></div>
          <div className="flex gap-3 rounded-lg border border-app-warning/20 bg-app-warning/5 p-3"><AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-app-warning" aria-hidden="true" /><p><strong className="text-app-text">Protected-file limitation:</strong> local access does not bypass encryption. The vault may need to be unlocked, and unsupported third-party workflows fail closed rather than receive plaintext.</p></div>
        </div>
        <footer className="flex justify-end border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onClose} className="quiet-control bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">Understood</button></footer>
      </div>
    </div>
  );
}
