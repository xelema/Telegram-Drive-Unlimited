import { Folder, Download, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface BottomNavBarProps {
  activeTab: 'files' | 'downloads' | 'settings';
  setActiveTab: (tab: 'files' | 'downloads' | 'settings') => void;
  isAndroid?: boolean;
  isTelevision?: boolean;
}

export function BottomNavBar({ activeTab, setActiveTab, isAndroid, isTelevision }: BottomNavBarProps) {
  const { t } = useTranslation();

  const tabs = [
    { id: 'files', labelKey: 'common.files', icon: Folder },
    { id: 'downloads', labelKey: 'common.transfers', icon: Download },
    { id: 'settings', labelKey: 'common.settings', icon: Settings },
  ] as const;

  return (
    <nav aria-label="Primary" className={`fixed left-4 right-4 bg-telegram-bg/85 backdrop-blur-xl border border-telegram-border/50 rounded-2xl shadow-2xl flex justify-around py-2 z-50 transition-all duration-300 md:left-[296px] ${isTelevision ? 'tv-primary-nav' : isAndroid ? 'bottom-[calc(5rem+env(safe-area-inset-bottom,0px))]' : 'bottom-5'}`}>
      {tabs.map(({ id, labelKey, icon: Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            aria-current={isActive ? 'page' : undefined}
            aria-label={t(labelKey)}
            className={`relative flex min-h-12 min-w-16 flex-col items-center justify-center gap-1 transition-all duration-300 ${
              isActive ? 'text-telegram-primary scale-110' : 'text-telegram-subtext hover:text-telegram-text'
            }`}
          >
            <Icon className="w-5 h-5" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-wide uppercase">{t(labelKey)}</span>
            {isActive && (
              <span className="absolute -bottom-1 w-1.5 h-1.5 bg-telegram-primary rounded-full shadow-[0_0_8px_var(--telegram-primary)]" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
