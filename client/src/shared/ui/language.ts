import * as d3 from 'd3';
import { getCurrentLanguage, setLanguage, type Language } from '../../shared/lang/i18n-lite';
import { tr } from '../../shared/lang/i18n-lite';
import { createSettingsDropdown } from './settingsDropdown';

export type LanguageManagerOptions = {
    onLanguageChange?: () => void;
};

export type LanguageManager = {
    dispose: () => void;
};

const languageOptions: Array<{ lang: Language; label: string }> = [
    { lang: 'en', label: 'English' },
    { lang: 'zh', label: 'Chinese' },
];

export function initLanguageManager(options: LanguageManagerOptions = {}, containerSelector: string = '#language_toggle'): LanguageManager {
    const { onLanguageChange } = options;
    const container = d3.select(containerSelector);

    const selectLang = (lang: Language) => {
        setLanguage(lang);
        dropdown.updateCurrent(lang);
        onLanguageChange?.();
        location.reload();
    };

    const dropdown = createSettingsDropdown<Language>({
        container,
        classPrefix: 'language',
        options: languageOptions.map(({ lang, label }) => ({ value: lang, html: `<span>${tr(label)}</span>` })),
        dataAttr: 'data-lang',
        bodyClickNamespace: 'language-dropdown',
        onSelect: selectLang,
    });

    const storageListener = (event: StorageEvent) => {
        if (event.key !== 'app_language') return;
        if (event.newValue === 'en' || event.newValue === 'zh') location.reload();
    };

    dropdown.updateCurrent(getCurrentLanguage());
    window.addEventListener('storage', storageListener);

    return {
        dispose: () => {
            window.removeEventListener('storage', storageListener);
            dropdown.dispose();
        },
    };
}
