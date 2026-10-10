import i18n from '../../../i18n';
import {useTranslation} from 'react-i18next';
import { useRef, useState } from 'react';
import { ArrowRight, FolderLock, HardDrive, ShieldCheck, X } from 'lucide-react';
import { useModalFocus } from '../../../hooks/useModalFocus';

const introductionSteps = [
  { id: 'drive', icon: HardDrive, titleKey: 'drive_intro.drive_title', bodyKey: 'drive_intro.drive_body' },
  { id: 'folders', icon: FolderLock, titleKey: 'drive_intro.folders_title', bodyKey: 'drive_intro.folders_body' },
  { id: 'protection', icon: ShieldCheck, titleKey: 'drive_intro.protection_title', bodyKey: 'drive_intro.protection_body' },
];

interface DriveConceptTourProps {
  onFinish: () => void;
  onOpenHelp: () => void;
}

export function DriveConceptTour({ onFinish, onOpenHelp }: DriveConceptTourProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onFinish);
  const steps = introductionSteps;
  const step = steps[index];
  const Icon = step.icon;
  const isLastStep = index === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="drive-tour-title" tabIndex={-1} className="quiet-raised w-[min(500px,calc(100vw-2rem))] overflow-hidden">
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><span className="text-xs font-semibold uppercase tracking-wider text-app-accent">{t('drive_intro.progress', { current: index + 1, total: steps.length })}</span><button type="button" onClick={onFinish} className="quiet-control p-2 text-app-text-secondary" aria-label={t('drive_intro.skip')}><X className="h-4 w-4" /></button></header>
        <div className="p-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-container bg-app-selected text-app-accent"><Icon className="h-7 w-7" /></div>
          <h2 id="drive-tour-title" className="mt-5 text-xl font-semibold text-app-text">{t(step.titleKey)}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-app-text-secondary">{t(step.bodyKey)}</p>
          <div className="mt-6 flex justify-center gap-2" aria-label={t('drive_intro.progress_label')}>{steps.map((_, stepIndex) => <span key={stepIndex} className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${stepIndex === index ? 'w-7 bg-app-accent' : 'w-1.5 bg-app-border'}`} />)}</div>
        </div>
        <footer className="flex items-center justify-between border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onOpenHelp} className="quiet-control px-3 py-2 text-xs font-medium text-app-text-secondary">{t('drive_intro.help')}</button><button type="button" onClick={() => isLastStep ? onFinish() : setIndex(value => value + 1)} className="quiet-control flex items-center gap-2 bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">{isLastStep ? i18n.t('ui_copy.finish') : i18n.t("workspace.next")}<ArrowRight className="h-4 w-4 rtl:rotate-180" /></button></footer>
      </div>
    </div>
  );
}
