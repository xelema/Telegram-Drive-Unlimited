import {useTranslation} from 'react-i18next';
import i18n from '../../../i18n';
import { useRef } from 'react';
import { BookOpen, ExternalLink, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useModalFocus } from '../../../hooks/useModalFocus';

const topics = [
  { questionKey: 'help_topics.storage_question', answerKey: 'help_topics.storage_answer' },
  { questionKey: 'help_topics.limits_question', answerKey: 'help_topics.limits_answer' },
  { questionKey: 'help_topics.protection_question', answerKey: 'help_topics.protection_answer' },
  { questionKey: 'help_topics.sharing_question', answerKey: 'help_topics.sharing_answer' },
  { questionKey: 'help_topics.guest_question', answerKey: 'help_topics.guest_answer' },
];

export function HelpCenterDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  return (
    <div className="fixed inset-0 z-[270] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="help-center-title" tabIndex={-1} className="quiet-raised flex max-h-[85vh] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><h2 id="help-center-title" className="flex items-center gap-2 text-base font-semibold text-app-text"><BookOpen className="h-5 w-5 text-app-accent" />{i18n.t('ui_copy.help_faq')}</h2><button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label={i18n.t('ui_copy.close_help')}><X className="h-4 w-4" /></button></header>
        <div className="space-y-3 overflow-y-auto p-5">{topics.map(({ questionKey, answerKey }, index) => <details key={questionKey} open={index === 0} className="quiet-surface group p-4"><summary className="cursor-pointer text-sm font-medium text-app-text">{t(questionKey)}</summary><p className="mt-3 text-xs leading-6 text-app-text-secondary">{t(answerKey)}</p></details>)}</div>
        <footer className="flex items-center justify-between border-t border-app-border-subtle px-5 py-4"><span className="text-xs text-app-text-secondary">{t('help_topics.more')}</span><button type="button" onClick={() => void open('https://github.com/caamer20/Telegram-Drive/issues')} className="quiet-control flex items-center gap-2 px-3 py-2 text-xs font-medium text-app-accent">{t('help_topics.support')}<ExternalLink className="h-3.5 w-3.5" /></button></footer>
      </div>
    </div>
  );
}
