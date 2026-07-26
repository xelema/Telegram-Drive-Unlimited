import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useTranslation } from 'react-i18next';

export function ThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    const { t } = useTranslation();
    const label = theme === 'dark' ? t('common.switch_light') : t('common.switch_dark');

    return (
        <button
            onClick={toggleTheme}
            className="quiet-control flex h-11 w-11 items-center justify-center text-app-text-secondary hover:text-app-accent"
            title={label}
            aria-label={label}
        >
            {theme === 'dark' ? (
                <Sun className="h-5 w-5" />
            ) : (
                <Moon className="h-5 w-5" />
            )}
        </button>
    );
}
