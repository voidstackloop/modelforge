import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DICTIONARIES, type Dictionary, type Locale } from "./translations";

interface I18nContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: Dictionary;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: React.ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>("en");

    useEffect(() => {
        if (!window.api) return;
        window.api.settings.get().then((s) => {
            if (s.language === "tr" || s.language === "en") setLocaleState(s.language);
        });
    }, []);

    const setLocale = useCallback((next: Locale) => {
        setLocaleState(next);
        if (window.api) window.api.settings.save({ language: next });
    }, []);

    return (
        <I18nContext.Provider value={{ locale, setLocale, t: DICTIONARIES[locale] }}>
            {children}
        </I18nContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- context + hook co-location is the standard pattern here
export function useI18n() {
    const ctx = useContext(I18nContext);
    if (ctx === undefined) throw new Error("useI18n must be used within I18nProvider");
    return ctx;
}
