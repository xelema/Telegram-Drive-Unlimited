import {useTranslation} from 'react-i18next';
import i18n from '../../i18n';
import { useRef } from 'react';
import { AlertTriangle, KeyRound, Network, ShieldCheck, X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';

export type LocalAccessService = 'webdav' | 'rest';

export function AccessTransparencyDialog({ service, onClose }: { service: LocalAccessService; onClose: () => void }) {
    useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  const isWebDav = service === 'webdav';

  return (
    <div className="fixed inset-0 z-[290] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="local-access-title" tabIndex={-1} className="quiet-raised w-[min(540px,calc(100vw-2rem))] overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4">
          <h2 id="local-access-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><Network className="h-5 w-5 text-app-accent" aria-hidden="true" />{isWebDav ? i18n.t('access_copy.webdav_title') : i18n.t('access_copy.rest_title')}</h2>
          <button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label={i18n.t('access_copy.close')}><X className="h-4 w-4" aria-hidden="true" /></button>
        </header>
        <div className="space-y-4 p-5 text-sm leading-6 text-app-text-secondary">
          <div className="flex gap-3"><Network className="mt-1 h-4 w-4 shrink-0 text-app-accent" aria-hidden="true" /><p>{i18n.t('access_copy.server_scope')}</p></div>
          <div className="flex gap-3"><KeyRound className="mt-1 h-4 w-4 shrink-0 text-app-warning" aria-hidden="true" /><p>{isWebDav ? i18n.t('access_copy.webdav_token') : i18n.t('access_copy.rest_key')}</p></div>
          <div className="flex gap-3"><ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-app-success" aria-hidden="true" /><p>{isWebDav ? i18n.t('access_copy.webdav_changes') : i18n.t('access_copy.rest_changes')}</p></div>
          <div className="flex gap-3 rounded-lg border border-app-warning/20 bg-app-warning/5 p-3"><AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-app-warning" aria-hidden="true" /><p><strong className="text-app-text">{i18n.t('access_copy.protection_label')}</strong> {i18n.t('access_copy.protection_warning')}</p></div>
        </div>
        <footer className="flex justify-end border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onClose} className="quiet-control bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">{i18n.t('ui_copy.understood')}</button></footer>
      </div>
    </div>
  );
}
