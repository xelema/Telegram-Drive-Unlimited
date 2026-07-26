import { createContext, useContext, useState, ReactNode, useLayoutEffect, useCallback } from 'react';
import { CustomTheme, applyTheme as applyThemeToDOM, removeCustomTheme as removeCustomThemeFromDOM } from '../theme/themeEngine';
import { BUILTIN_THEMES } from '../theme/presets';

type Theme = 'light' | 'dark';
type ThemePreference = Theme | 'system' | 'default';

interface ThemeContextType {
    theme: Theme;
    themePreference: ThemePreference;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
    setThemePreference: (theme: ThemePreference) => void;
    // Custom theme engine
    customThemes: CustomTheme[];
    activeCustomThemeId: string | null;
    setActiveCustomTheme: (id: string | null) => void;
    addCustomTheme: (theme: CustomTheme) => void;
    deleteCustomTheme: (id: string) => void;
    updateCustomTheme: (id: string, patch: Partial<CustomTheme>) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Safe localStorage read: returns the value or null on any error
function safeTryGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

// Safe localStorage write: best-effort, silently ignores errors
function safeTrySet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage unavailable — theme still works in-memory for this session
    }
}

// Get initial theme synchronously to prevent flash
function getSystemTheme(): Theme {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
}

function getInitialPreference(): ThemePreference {
    if (typeof window !== 'undefined') {
        const preference = safeTryGet('theme-preference') as ThemePreference | null;
        if (preference === 'light' || preference === 'dark' || preference === 'system' || preference === 'default') return preference;
        const saved = safeTryGet('theme') as Theme | null;
        if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'default';
}

function resolveTheme(preference: ThemePreference, systemTheme: Theme): Theme {
    if (preference === 'system') return systemTheme;
    if (preference === 'default') return 'dark';
    return preference;
}

// Apply theme to DOM immediately
function applyBaseTheme(theme: Theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark');
    } else {
        root.classList.add('dark');
        root.classList.remove('light');
    }
}

// Load user-created themes from localStorage
function loadUserThemes(): CustomTheme[] {
    const raw = safeTryGet('user-themes');
    if (!raw) return [];
    try {
        return JSON.parse(raw) as CustomTheme[];
    } catch {
        return [];
    }
}

function saveUserThemes(themes: CustomTheme[]): void {
    safeTrySet('user-themes', JSON.stringify(themes));
}

// Apply theme immediately on script load (before React hydration)
if (typeof window !== 'undefined') {
    const initialPreference = getInitialPreference();
    applyBaseTheme(resolveTheme(initialPreference, getSystemTheme()));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [themePreference, setThemePreferenceState] = useState<ThemePreference>(getInitialPreference);
    const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
    const theme: Theme = resolveTheme(themePreference, systemTheme);
    const [userThemes, setUserThemes] = useState<CustomTheme[]>(() => loadUserThemes());
    const [activeCustomThemeId, setActiveCustomThemeIdState] = useState<string | null>(
        () => safeTryGet('active-custom-theme-id')
    );

    // All available themes: builtins + user-created
    const allThemes = [...BUILTIN_THEMES, ...userThemes];

    useLayoutEffect(() => {
        const query = window.matchMedia('(prefers-color-scheme: light)');
        const handleChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'light' : 'dark');
        query.addEventListener('change', handleChange);
        return () => query.removeEventListener('change', handleChange);
    }, []);

    // Apply base theme to DOM
    useLayoutEffect(() => {
        if (!activeCustomThemeId) {
            removeCustomThemeFromDOM();
            applyBaseTheme(theme);
        }
        safeTrySet('theme', theme);
        safeTrySet('theme-preference', themePreference);
    }, [theme, themePreference, activeCustomThemeId]);

    // Apply custom theme to DOM
    useLayoutEffect(() => {
        if (activeCustomThemeId) {
            const found = allThemes.find(t => t.id === activeCustomThemeId);
            if (found) {
                applyThemeToDOM(found);
            } else {
                // Theme was deleted — clear
                setActiveCustomThemeIdState(null);
                safeTrySet('active-custom-theme-id', '');
                removeCustomThemeFromDOM();
                applyBaseTheme(theme);
            }
        }
    }, [activeCustomThemeId, allThemes, theme]);

    const toggleTheme = useCallback(() => {
        if (activeCustomThemeId) {
            // Deactivate custom theme, toggle to opposite base mode
            const activeTheme = allThemes.find(t => t.id === activeCustomThemeId);
            const nextBase: Theme = activeTheme?.isDark ? 'light' : 'dark';
            setActiveCustomThemeIdState(null);
            safeTrySet('active-custom-theme-id', '');
            removeCustomThemeFromDOM();
            setThemePreferenceState(nextBase);
        } else {
            setThemePreferenceState(theme === 'dark' ? 'light' : 'dark');
        }
    }, [activeCustomThemeId, allThemes, theme]);

    const setTheme = useCallback((newTheme: Theme) => {
        setActiveCustomThemeIdState(null);
        safeTrySet('active-custom-theme-id', '');
        removeCustomThemeFromDOM();
        setThemePreferenceState(newTheme);
    }, []);

    const setThemePreference = useCallback((newTheme: ThemePreference) => {
        setActiveCustomThemeIdState(null);
        safeTrySet('active-custom-theme-id', '');
        removeCustomThemeFromDOM();
        setThemePreferenceState(newTheme);
    }, []);

    const setActiveCustomTheme = useCallback((id: string | null) => {
        setActiveCustomThemeIdState(id);
        safeTrySet('active-custom-theme-id', id || '');
        if (!id) {
            removeCustomThemeFromDOM();
            applyBaseTheme(theme);
        }
    }, [theme]);

    const addCustomTheme = useCallback((t: CustomTheme) => {
        setUserThemes(prev => {
            const next = [...prev, t];
            saveUserThemes(next);
            return next;
        });
    }, []);

    const deleteCustomTheme = useCallback((id: string) => {
        setUserThemes(prev => {
            const next = prev.filter(t => t.id !== id);
            saveUserThemes(next);
            return next;
        });
        // If the deleted theme was active, deactivate
        setActiveCustomThemeIdState(prev => {
            if (prev === id) {
                safeTrySet('active-custom-theme-id', '');
                removeCustomThemeFromDOM();
                applyBaseTheme(theme);
                return null;
            }
            return prev;
        });
    }, [theme]);

    const updateCustomTheme = useCallback((id: string, patch: Partial<CustomTheme>) => {
        setUserThemes(prev => {
            const next = prev.map(t => t.id === id ? { ...t, ...patch, id } : t);
            saveUserThemes(next);
            return next;
        });
    }, []);

    return (
        <ThemeContext.Provider value={{
            theme,
            themePreference,
            toggleTheme,
            setTheme,
            setThemePreference,
            customThemes: allThemes,
            activeCustomThemeId,
            setActiveCustomTheme,
            addCustomTheme,
            deleteCustomTheme,
            updateCustomTheme,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) throw new Error('useTheme must be used within a ThemeProvider');
    return context;
};
