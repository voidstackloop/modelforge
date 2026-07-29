import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";
export type ColorTheme =
    | "default"
    | "blue"
    | "green"
    | "purple"
    | "orange"
    | "rose"
    | "monokai"
    | "dracula"
    | "nord"
    | "solarized"
    | "gruvbox"
    | "catppuccin";

// eslint-disable-next-line react-refresh/only-export-components -- shared with the color-theme picker in Settings
export const COLOR_THEMES: readonly ColorTheme[] = [
    "default",
    "blue",
    "green",
    "purple",
    "orange",
    "rose",
    "monokai",
    "dracula",
    "nord",
    "solarized",
    "gruvbox",
    "catppuccin",
] as const;

type ThemeProviderProps = {
    children: React.ReactNode;
    defaultTheme?: Theme;
    storageKey?: string;
};

type ThemeProviderState = {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    colorTheme: ColorTheme;
    setColorTheme: (colorTheme: ColorTheme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);
const COLOR_THEME_STORAGE_KEY = "app-ui-color-theme";
const LEGACY_ACCENT_STORAGE_KEY = "vite-ui-accent";

function isTheme(value: string | null): value is Theme {
    return value === "dark" || value === "light" || value === "system";
}

function isColorTheme(value: string | null): value is ColorTheme {
    return value !== null && COLOR_THEMES.some((candidate) => candidate === value);
}

export function ThemeProvider({
    children,
    defaultTheme = "system",
    storageKey = "vite-ui-theme",
}: ThemeProviderProps) {
    const [theme, setThemeState] = useState<Theme>(() => {
        const storedTheme = localStorage.getItem(storageKey);
        return isTheme(storedTheme) ? storedTheme : defaultTheme;
    });
    const [colorTheme, setColorThemeState] = useState<ColorTheme>(() => {
        const storedTheme = localStorage.getItem(COLOR_THEME_STORAGE_KEY)
            ?? localStorage.getItem(LEGACY_ACCENT_STORAGE_KEY);
        return isColorTheme(storedTheme) ? storedTheme : "default";
    });

    useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove("light", "dark");

        const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
        const applyTheme = () => {
            root.classList.remove("light", "dark");
            root.classList.add(theme === "system" ? (colorScheme.matches ? "dark" : "light") : theme);
        };

        applyTheme();
        if (theme !== "system") return;

        colorScheme.addEventListener("change", applyTheme);
        return () => colorScheme.removeEventListener("change", applyTheme);
    }, [theme]);

    useEffect(() => {
        const root = window.document.documentElement;
        root.classList.remove(...COLOR_THEMES.map((candidate) => `theme-${candidate}`));
        if (colorTheme !== "default") root.classList.add(`theme-${colorTheme}`);
    }, [colorTheme]);

    const setTheme = (theme: Theme) => {
        localStorage.setItem(storageKey, theme);
        setThemeState(theme);
    };

    const setColorTheme = (nextColorTheme: ColorTheme) => {
        localStorage.setItem(COLOR_THEME_STORAGE_KEY, nextColorTheme);
        setColorThemeState(nextColorTheme);
    };

    return (
        <ThemeProviderContext.Provider value={{ theme, setTheme, colorTheme, setColorTheme }}>
            {children}
        </ThemeProviderContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
    const context = useContext(ThemeProviderContext);
    if (context === undefined)
        throw new Error("useTheme must be used within a ThemeProvider");
    return context;
};
