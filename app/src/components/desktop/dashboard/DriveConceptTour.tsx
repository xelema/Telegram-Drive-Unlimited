import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, FolderLock, HardDrive, Heart, ShieldCheck, X } from 'lucide-react';
import { useModalFocus } from '../../../hooks/useModalFocus';

const introductionSteps = [
  { id: 'drive', icon: HardDrive, title: 'Your Telegram account becomes the drive', body: 'Saved Messages is your home storage. Telegram Drive reads and writes files directly through your Telegram session.' },
  { id: 'folders', icon: FolderLock, title: 'Folders are private channels', body: 'Creating a folder creates a private Telegram channel owned by your account. The app presents those channels as a familiar drive.' },
  { id: 'protection', icon: ShieldCheck, title: 'Store normally or protect first', body: 'Every upload can be stored normally or protected locally before it reaches Telegram. Sharing and WebDAV remain explicit, opt-in actions.' },
];

const supporterStep = {
  id: 'supporter',
  icon: Heart,
  title: 'Lifetime Ad-Free Supporter License',
  body: 'One $5 USD PayPal payment removes desktop sponsor placements for life—no subscription and no locked features. Activation supports up to three desktop devices, stays active through normal updates, and includes a recovery code for reinstalls or another device.',
};

interface DriveConceptTourProps {
  onFinish: () => void;
  onOpenHelp: () => void;
  onOpenSupporter?: () => void;
  includeSupporterStep?: boolean;
  onSupporterShown?: () => void;
}

export function DriveConceptTour({ onFinish, onOpenHelp, onOpenSupporter, includeSupporterStep = true, onSupporterShown }: DriveConceptTourProps) {
  const [index, setIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onFinish);
  const steps = includeSupporterStep ? [...introductionSteps, supporterStep] : introductionSteps;
  const step = steps[index];
  const Icon = step.icon;
  const isLastStep = index === steps.length - 1;
  const isSupporterStep = step.id === 'supporter';

  useEffect(() => {
    if (step.id === 'supporter') onSupporterShown?.();
  }, [onSupporterShown, step.id]);

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="drive-tour-title" tabIndex={-1} className="quiet-raised w-[min(500px,calc(100vw-2rem))] overflow-hidden">
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><span className="text-xs font-semibold uppercase tracking-wider text-app-accent">Getting started · {index + 1} of {steps.length}</span><button type="button" onClick={onFinish} className="quiet-control p-2 text-app-text-secondary" aria-label="Skip drive introduction"><X className="h-4 w-4" /></button></header>
        <div className="p-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-container bg-app-selected text-app-accent"><Icon className="h-7 w-7" /></div>
          <h2 id="drive-tour-title" className="mt-5 text-xl font-semibold text-app-text">{step.title}</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-app-text-secondary">{step.body}</p>
          <div className="mt-6 flex justify-center gap-2" aria-label="Introduction progress">{steps.map((_, stepIndex) => <span key={stepIndex} className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${stepIndex === index ? 'w-7 bg-app-accent' : 'w-1.5 bg-app-border'}`} />)}</div>
        </div>
        <footer className="flex items-center justify-between border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={isSupporterStep ? onFinish : onOpenHelp} className="quiet-control px-3 py-2 text-xs font-medium text-app-text-secondary">{isSupporterStep ? 'Not now' : 'Open Help & FAQ'}</button><button type="button" onClick={() => isSupporterStep ? (onOpenSupporter ?? onFinish)() : isLastStep ? onFinish() : setIndex(value => value + 1)} className="quiet-control flex items-center gap-2 bg-app-accent px-4 py-2 text-sm font-semibold text-app-accent-contrast">{isSupporterStep ? 'View supporter option' : isLastStep ? 'Finish' : 'Next'}<ArrowRight className="h-4 w-4 rtl:rotate-180" /></button></footer>
      </div>
    </div>
  );
}

interface SupporterReminderDialogProps {
  onClose: () => void;
  onOpenSupporter: () => void;
}

export function SupporterReminderDialog({ onClose, onOpenSupporter }: SupporterReminderDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="supporter-reminder-title" tabIndex={-1} className="quiet-raised w-[min(560px,calc(100vw-2rem))] overflow-hidden">
        <header className="flex items-center justify-between border-b border-app-border-subtle px-5 py-4"><span className="text-xs font-semibold uppercase tracking-wider text-app-accent">Lifetime Ad-Free Supporter License</span><button type="button" onClick={onClose} className="quiet-control p-2 text-app-text-secondary" aria-label="Dismiss supporter offer"><X className="h-4 w-4" /></button></header>
        <div className="p-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-container bg-app-selected text-app-accent"><Heart className="h-7 w-7" /></div>
          <h2 id="supporter-reminder-title" className="mt-5 text-xl font-semibold text-app-text">One payment. No subscription. No sponsor ads.</h2>
          <div className="mt-3 text-3xl font-semibold text-app-text">$5 <span className="text-sm font-medium text-app-text-secondary">USD once</span></div>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-app-text-secondary">Every feature remains free for everyone. The optional supporter license removes desktop sponsor placements for life on up to three devices.</p>
          <div className="mx-auto mt-4 grid max-w-lg gap-2 text-start text-xs text-app-text-secondary sm:grid-cols-3">
            {['Normal updates stay active', 'Recovery code included', 'PayPal handles payment'].map(item => <span key={item} className="flex items-start gap-2 rounded-lg bg-app-surface-sunken/30 p-2.5"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-app-success" />{item}</span>)}
          </div>
          <p className="mx-auto mt-4 max-w-md text-xs leading-5 text-app-text-tertiary">Telegram Drive does not store your card details or PayPal email. Refunds are not automatic or guaranteed except where required by law; refunds and payment reversals revoke ad-free access.</p>
        </div>
        <footer className="flex items-center justify-between border-t border-app-border-subtle px-5 py-4"><button type="button" onClick={onClose} className="quiet-control px-3 py-2 text-xs font-medium text-app-text-secondary">Maybe later</button><button type="button" onClick={onOpenSupporter} className="quiet-control flex items-center gap-2 bg-app-accent px-4 py-2.5 text-sm font-semibold text-app-accent-contrast">View $5 lifetime license<ArrowRight className="h-4 w-4 rtl:rotate-180" /></button></footer>
      </div>
    </div>
  );
}
