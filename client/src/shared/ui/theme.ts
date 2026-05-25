import * as d3 from 'd3';
import { tr } from '../../shared/lang/i18n-lite';
import { createSettingsDropdown } from './settingsDropdown';
import { lsGet, lsRemove, lsSet } from '../storage/localStorageHelpers';

export type Theme = 'light' | 'dark';
export type ThemeMode = 'light' | 'dark' | 'auto';

export type ThemeManagerOptions = {
    onThemeChange?: (theme: Theme) => void;
};

export type ThemeManager = {
    dispose: () => void;
};

function getSystemTheme(): Theme {
    if (window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
}

function getActualTheme(mode: ThemeMode): Theme {
    if (mode === 'auto') return getSystemTheme();
    return mode;
}

function getInitialThemeMode(): ThemeMode {
    const savedMode = lsGet('theme-mode') as ThemeMode | null;
    if (savedMode && ['light', 'dark', 'auto'].includes(savedMode)) return savedMode;
    const oldTheme = lsGet('theme') as Theme | null;
    if (oldTheme === 'light' || oldTheme === 'dark') {
        lsRemove('theme');
        return oldTheme;
    }
    return 'auto';
}

/**
 * 无主题控件时仅同步 data-theme（与首页设置通过 localStorage 联动，含跨标签 storage 与 auto 模式下的系统主题变化）
 */
export function applyStoredTheme(options: ThemeManagerOptions = {}): { dispose: () => void } {
    const { onThemeChange } = options;

    const applyTheme = (theme: Theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        onThemeChange?.(theme);
    };

    const initialMode = getInitialThemeMode();
    applyTheme(getActualTheme(initialMode));

    const storageListener = (event: StorageEvent) => {
        if (event.key !== 'theme-mode') return;
        const mode = getInitialThemeMode();
        applyTheme(getActualTheme(mode));
    };
    window.addEventListener('storage', storageListener);

    let mediaQuery: MediaQueryList | null = null;
    const systemThemeListener = () => {
        const currentMode = lsGet('theme-mode') as ThemeMode | null;
        if (currentMode === 'auto' || (!currentMode && !lsGet('theme'))) {
            applyTheme(mediaQuery!.matches ? 'dark' : 'light');
        }
    };
    if (window.matchMedia) {
        mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', systemThemeListener);
    }

    return {
        dispose: () => {
            mediaQuery?.removeEventListener('change', systemThemeListener);
            window.removeEventListener('storage', storageListener);
        },
    };
}

export function initThemeManager(options: ThemeManagerOptions = {}, containerSelector: string = '#dark_mode_toggle'): ThemeManager {
    const { onThemeChange } = options;
    const container = d3.select(containerSelector);
    const themeOptions: Array<{ mode: ThemeMode; icon: string; label: string }> = [
        { mode: 'light', icon: '☀️', label: tr('Light') },
        { mode: 'dark', icon: '🌙', label: tr('Dark') },
        { mode: 'auto', icon: '🔄', label: tr('Auto') },
    ];

    const applyTheme = (theme: Theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        onThemeChange?.(theme);
    };

    const setThemeMode = (mode: ThemeMode, persist: boolean = true) => {
        if (persist) lsSet('theme-mode', mode);
        else lsRemove('theme-mode');
        applyTheme(getActualTheme(mode));
        dropdown.updateCurrent(mode);
    };

    const dropdown = createSettingsDropdown<ThemeMode>({
        container,
        classPrefix: 'theme',
        options: themeOptions.map(({ mode, icon, label }) => ({
            value: mode,
            html: `${icon} <span>${label}</span>`,
        })),
        dataAttr: 'data-mode',
        bodyClickNamespace: 'theme-dropdown',
        onSelect: setThemeMode,
    });

    const storageListener = (event: StorageEvent) => {
        if (event.key !== 'theme-mode') return;
        const mode = getInitialThemeMode();
        applyTheme(getActualTheme(mode));
        dropdown.updateCurrent(mode);
    };

    const initialMode = getInitialThemeMode();
    dropdown.updateCurrent(initialMode);
    applyTheme(getActualTheme(initialMode));

    let mediaQuery: MediaQueryList | null = null;
    const systemThemeListener = () => {
        const currentMode = lsGet('theme-mode') as ThemeMode | null;
        if (currentMode === 'auto' || (!currentMode && !lsGet('theme'))) {
            applyTheme(mediaQuery!.matches ? 'dark' : 'light');
        }
    };
    if (window.matchMedia) {
        mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', systemThemeListener);
    }
    window.addEventListener('storage', storageListener);

    return {
        dispose: () => {
            mediaQuery?.removeEventListener('change', systemThemeListener);
            window.removeEventListener('storage', storageListener);
            dropdown.dispose();
        },
    };
}

