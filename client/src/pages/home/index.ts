/**
 * 极简导航首页：主题与语言与 analysis 等页通过 localStorage 一致。
 */
import '../../shared/core/d3-polyfill';
import dagPreviewLight from '../../assets/images/dag.mov';
import dagPreviewDark from '../../assets/images/dag-dark.mov';
import dagSpiralPreview from '../../assets/images/dag-spiral.mov';
import dagCotPreview from '../../assets/images/dag-cot.png';
import '../../css/pages/home.scss';

import { initThemeManager, type Theme } from '../../shared/ui/theme';
import { initLanguageManager } from '../../shared/ui/language';
import { getCurrentLanguage, initI18n, tr } from '../../shared/lang/i18n-lite';
import { AdminManager } from '../../shared/cross/adminManager';
import { SettingsMenuManager } from '../../shared/cross/settingsMenuManager';
import { initializeCommonApp } from '../../shared/bootstrap';
import URLHandler from '../../shared/core/URLHandler';
import { DEFAULT_DEMO_URL_PARAM } from '../../shared/cross/contentUrl';

/** 首页轮播三帧 → 打包 demo slug（与 demos/causal_flow/*.json 文件名一致） */
const GEN_ATTRIBUTE_CAROUSEL_DEMO_SLUG = {
    flow: { en: 'Write a sonnet about love', zh: '写一首绝句，主题是春天' },
    spiral: { en: '过拟合｜李白 将进酒', zh: '过拟合｜李白 将进酒' },
    cot: { en: 'CoT | 苏州所在省的省会', zh: 'CoT | 苏州所在省的省会' },
} as const;

type GenAttributeCarouselSlide = keyof typeof GEN_ATTRIBUTE_CAROUSEL_DEMO_SLUG;

function genAttributeDemoHref(slide: GenAttributeCarouselSlide): string {
    const lang = getCurrentLanguage() === 'zh' ? 'zh' : 'en';
    const slug = GEN_ATTRIBUTE_CAROUSEL_DEMO_SLUG[slide][lang];
    return `causal_flow.html?${DEFAULT_DEMO_URL_PARAM}=${encodeURIComponent(slug)}`;
}

function applyGenAttributeNavCardHref(): void {
    const card = document.querySelector<HTMLElement>('.nav-landing-card[data-nav-page="causalFlow"]');
    if (!card) return;
    card.querySelectorAll<HTMLAnchorElement>('a.nav-landing-card-link[data-demo-slide]').forEach((link) => {
        const slide = link.dataset.demoSlide as GenAttributeCarouselSlide | undefined;
        if (slide && slide in GEN_ATTRIBUTE_CAROUSEL_DEMO_SLUG) {
            link.href = genAttributeDemoHref(slide);
        }
    });
}

const GEN_ATTRIBUTE_BADGE_LINK = 'http://xhslink.com/o/A7VLi99aBvG';

const DAG_PREVIEW_BY_THEME: Record<Theme, string> = {
    light: dagPreviewLight,
    dark: dagPreviewDark,
};

const GEN_ATTR_CAROUSEL_INTERVAL_MS = 3000;

function initGenAttributeCardCarousel(): (theme: Theme) => void {
    const card = document.querySelector<HTMLElement>('.nav-landing-card[data-nav-page="causalFlow"]');
    const viewport = card?.querySelector<HTMLElement>('.nav-landing-card-carousel-viewport');
    const slides = viewport
        ? Array.from(viewport.querySelectorAll<HTMLElement>('.nav-landing-card-slide'))
        : [];
    const dots = card?.querySelectorAll<HTMLButtonElement>('.nav-landing-card-carousel-dots button');
    const flowVideo = card?.querySelector<HTMLVideoElement>('[data-slide="flow"] video');
    const spiralVideo = card?.querySelector<HTMLVideoElement>('[data-slide="spiral"] video');
    const cotImg = card?.querySelector<HTMLImageElement>('[data-slide="cot"] img');

    if (!card || !viewport || slides.length === 0 || !dots?.length || !flowVideo || !spiralVideo || !cotImg) {
        return () => {};
    }

    spiralVideo.src = dagSpiralPreview;
    cotImg.src = dagCotPreview;

    let index = 0;
    let paused = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let scrollSyncRaf = 0;
    let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const onScrollSettled = (): void => {
        syncIndexFromScroll();
        restartTimer();
    };

    const scheduleScrollSettled = (): void => {
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        scrollSettleTimer = setTimeout(() => {
            scrollSettleTimer = null;
            onScrollSettled();
        }, 150);
    };

    const syncDots = (): void => {
        dots.forEach((dot, i) => {
            dot.classList.toggle('is-active', i === index);
        });
    };

    const syncSlideVideos = (): void => {
        flowVideo.pause();
        spiralVideo.pause();
        if (index === 0) {
            void flowVideo.play().catch(() => {});
        } else if (index === 1) {
            void spiralVideo.play().catch(() => {});
        }
    };

    const syncIndexFromScroll = (): void => {
        const slideWidth = viewport.clientWidth;
        if (slideWidth <= 0) return;
        const nextIndex = Math.max(0, Math.min(slides.length - 1, Math.round(viewport.scrollLeft / slideWidth)));
        if (nextIndex === index) return;
        index = nextIndex;
        syncDots();
        syncSlideVideos();
    };

    const scrollToIndex = (nextIndex: number, behavior: ScrollBehavior = 'smooth'): void => {
        const i = ((nextIndex % slides.length) + slides.length) % slides.length;
        index = i;
        syncDots();
        syncSlideVideos();
        slides[i].scrollIntoView({ behavior, block: 'nearest', inline: 'start' });
    };

    const restartTimer = (): void => {
        if (timer) clearInterval(timer);
        timer = null;
        if (paused) return;
        timer = setInterval(() => {
            scrollToIndex(index + 1);
        }, GEN_ATTR_CAROUSEL_INTERVAL_MS);
    };

    card.addEventListener('mouseenter', () => {
        paused = true;
        if (timer) clearInterval(timer);
        timer = null;
    });
    card.addEventListener('mouseleave', () => {
        paused = false;
        restartTimer();
    });

    viewport.addEventListener(
        'scroll',
        () => {
            cancelAnimationFrame(scrollSyncRaf);
            scrollSyncRaf = requestAnimationFrame(syncIndexFromScroll);
            scheduleScrollSettled();
        },
        { passive: true }
    );
    viewport.addEventListener('scrollend', () => {
        if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
        onScrollSettled();
    });

    dots.forEach((dot, i) => {
        dot.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            scrollToIndex(i);
        });
    });

    const bindCarouselArrow = (selector: string, delta: number): void => {
        const btn = card.querySelector<HTMLButtonElement>(selector);
        if (!btn) return;
        btn.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            scrollToIndex(index + delta);
        });
    };
    bindCarouselArrow('.nav-landing-card-carousel-arrow--prev', -1);
    bindCarouselArrow('.nav-landing-card-carousel-arrow--next', 1);

    const syncFlowVideoTheme = (theme: Theme): void => {
        flowVideo.src = DAG_PREVIEW_BY_THEME[theme];
        if (index === 0) {
            void flowVideo.play().catch(() => {});
        }
    };

    scrollToIndex(0, 'instant');
    restartTimer();

    return syncFlowVideoTheme;
}

function bindGenAttributeBadgeLink(): void {
    const badge = document.querySelector<HTMLElement>(
        '.nav-landing-card[data-nav-page="causalFlow"] .nav-landing-card-badge'
    );
    if (!badge) return;
    badge.addEventListener('click', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(GEN_ATTRIBUTE_BADGE_LINK, '_blank', 'noopener');
    });
}

initI18n();

applyGenAttributeNavCardHref();
bindGenAttributeBadgeLink();

const syncGenAttributeCardPreview = initGenAttributeCardCarousel();

const apiPrefix = URLHandler.parameters['api'] || '';
const { api } = initializeCommonApp(apiPrefix);
const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

const themeManager = initThemeManager({ onThemeChange: syncGenAttributeCardPreview }, '#theme_dropdown');
const languageManager = initLanguageManager({ onLanguageChange: applyGenAttributeNavCardHref }, '#language_dropdown');

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
