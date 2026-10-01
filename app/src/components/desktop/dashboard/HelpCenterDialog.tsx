import { useRef } from 'react';
import { BookOpen, ExternalLink, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useModalFocus } from '../../../hooks/useModalFocus';

const topics = [
  ['Where are my files stored?', 'Files are Telegram messages in Saved Messages or private channels created as folders. Telegram Drive does not operate a separate cloud storage account.'],
  ['What are the practical limits?', 'A single Telegram object is limited to 2 GB in this app. Very large folders may take time to index; the live message count shows sync progress.'],
  ['What does Store & protect do?', 'It encrypts file bytes locally before upload. Keep your vault passphrase and recovery bundle safe: Telegram cannot recover protected files for you.'],
  ['How does sharing work?', 'Choose a Telegram channel link, a local password-protected link, or WebDAV/REST. Local servers and capability URLs must be enabled explicitly.'],
  ['Why does Finder Guest show an empty folder?', 'WebDAV access is granted by the token embedded in the complete /dav/<token>/ URL. Guest or anonymous login has no token-scoped access.'],
];

export function HelpCenterDialog({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  return (
    <div className="fixed inset-0 z-[270] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="help-center-title" tabIndex={-1} className="quiet-raised flex max-h-[85vh] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><h2 id="help-center-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><BookOpen className="h-5 w-5 text-app-accent" />Help &amp; FAQ</h2><button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label="Close Help and FAQ"><X className="h-4 w-4" /></button></header>
        <div className="space-y-3 overflow-y-auto p-5">{topics.map(([question, answer], index) => <details key={question} open={index === 0} className="quiet-surface group p-4"><summary className="cursor-pointer text-sm font-medium text-app-text">{question}</summary><p className="mt-3 text-xs leading-6 text-app-text-secondary">{answer}</p></details>)}</div>
        <footer className="flex items-center justify-between border-t border-app-border-subtle px-5 py-4"><span className="text-xs text-app-text-secondary">Need more help?</span><button type="button" onClick={() => void open('https://github.com/caamer20/Telegram-Drive/issues')} className="quiet-control flex items-center gap-2 px-3 py-2 text-xs font-medium text-app-accent">Open support issues<ExternalLink className="h-3.5 w-3.5" /></button></footer>
      </div>
    </div>
  );
}
