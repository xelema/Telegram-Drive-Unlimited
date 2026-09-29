import { useEffect, useState } from 'react';
import { SupporterOfferDialog } from '../shared/SupporterOfferDialog';
import { SettingsModal } from '../desktop/dashboard/SettingsModal';
import i18n, { ensureLanguageResource } from '../../i18n';
import { getLanguageInfo } from '../../i18n/languages';

/** Development-only fixture: real purchase presentation, with no checkout triggered. */
export function SupporterBrowserFixture() {
  const params = new URLSearchParams(window.location.search);
  const language = params.get('locale') ?? 'en';
  const [ready, setReady] = useState(false);
  const [offer, setOffer] = useState(!params.has('purchase'));
  const [details, setDetails] = useState(params.has('purchase'));
  useEffect(() => {
    let live = true;
    void ensureLanguageResource(language).then(() => i18n.changeLanguage(language)).then(() => {
      if (!live) return;
      document.documentElement.dir = getLanguageInfo(language).dir;
      document.documentElement.lang = language;
      setReady(true);
    });
    return () => { live = false; };
  }, [language]);
  if (!ready) return null;
  return (
    <main className="min-h-screen bg-app-canvas p-4 text-app-text" data-supporter-fixture-ready={language}>
      <h1 className="sr-only">Supporter presentation fixture</h1>
      {offer && <SupporterOfferDialog trigger="weekly" onClose={() => setOffer(false)} onOpenSupporter={() => { setOffer(false); setDetails(true); }} />}
      {details && (<SettingsModal ownerId={null} isOpen initialTab="license" focusSupporter onClose={() => setDetails(false)} />)}
    </main>
  );
}
