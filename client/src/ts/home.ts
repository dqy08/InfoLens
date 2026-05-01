/**
 * 极简导航首页：主题与语言与 analysis 等页通过 localStorage 一致。
 */
import './utils/d3-polyfill';
import dagPreviewLight from '../content/images/dag.mov';
import dagPreviewDark from '../content/images/dag-dark.mov';
import '../css/start.scss';
import '../css/home.scss';

import { initThemeManager, type Theme } from './ui/theme';
import { initLanguageManager } from './ui/language';
import { getCurrentLanguage, initI18n, tr } from './lang/i18n-lite';
import { AdminManager } from './utils/adminManager';
import { SettingsMenuManager } from './utils/settingsMenuManager';
import { initializeCommonApp } from './appInitializer';
import URLHandler from './utils/URLHandler';

initI18n();

/** 首页「LLM Causal Flow」卡片：按语言打开对应打包 demo（与 demos/gen_attribute/*.json 文件名一致） */
const GEN_ATTRIBUTE_HOME_DEMO_SLUG: Record<'en' | 'zh', string> = {
    en: 'Write a sonnet about love',
    zh: '写一首绝句，主题是春天',
};

function applyGenAttributeNavCardHref(): void {
    const a = document.querySelector<HTMLAnchorElement>('a.nav-landing-card[data-nav-page="genAttribute"]');
    if (!a) return;
    const slug = GEN_ATTRIBUTE_HOME_DEMO_SLUG[getCurrentLanguage() === 'zh' ? 'zh' : 'en'];
    a.setAttribute('href', `gen_attribute.html?demo=${encodeURIComponent(slug)}`);
}

const DAG_PREVIEW_BY_THEME: Record<Theme, string> = {
    light: dagPreviewLight,
    dark: dagPreviewDark,
};

function syncGenAttributeCardPreviewVideo(theme: Theme): void {
    const v = document.querySelector<HTMLVideoElement>(
        'a.nav-landing-card[data-nav-page="genAttribute"] video.nav-landing-card-shot'
    );
    if (!v) return;
    v.src = DAG_PREVIEW_BY_THEME[theme];
}

applyGenAttributeNavCardHref();

const apiPrefix = URLHandler.parameters['api'] || '';
const { api } = initializeCommonApp(apiPrefix);
const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

const themeManager = initThemeManager({ onThemeChange: syncGenAttributeCardPreviewVideo }, '#theme_dropdown');
const languageManager = initLanguageManager({}, '#language_dropdown');

void new SettingsMenuManager(
    '#settings_btn',
    '#settings_menu',
    '#admin_mode_btn',
    adminManager,
    api,
    undefined,
    undefined,
    themeManager,
    languageManager,
    'common'
);

document.documentElement.lang = getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en';
const metaDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
const desc = metaDesc?.getAttribute('content');
if (desc) metaDesc.setAttribute('content', tr(desc));
