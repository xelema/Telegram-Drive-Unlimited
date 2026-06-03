import { createContext, useContext, useState, ReactNode, useLayoutEffect } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
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
function getInitialTheme(): Theme {
    if (typeof window !== 'undefined') {
        const saved = safeTryGet('theme') as Theme | null;
        if (saved === 'light' || saved === 'dark') return saved;
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
    }
    return 'dark';
}

// Apply theme to DOM immediately
function applyTheme(theme: Theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark');
    } else {
        root.classList.add('dark');
        root.classList.remove('light');
    }
}

// Apply theme immediately on script load (before React hydration)
if (typeof window !== 'undefined') {
    applyTheme(getInitialTheme());
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(getInitialTheme);

    // Use useLayoutEffect to apply theme synchronously before paint
    useLayoutEffect(() => {
        applyTheme(theme);
        safeTrySet('theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setThemeState(t => t === 'dark' ? 'light' : 'dark');
    };

    const setTheme = (newTheme: Theme) => {
        setThemeState(newTheme);
    };

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) throw new Error('useTheme must be used within a ThemeProvider');
    return context;
};
