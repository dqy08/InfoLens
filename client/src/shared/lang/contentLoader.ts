/**
 * 外部内容加载器
 * 用于加载独立的 HTML 内容文件（如首页介绍等大段文本）
 */

import { getCurrentLanguage } from './i18n-lite';
import homeContentEn from '../../assets/content/home.en.html';
import homeContentZh from '../../assets/content/home.zh.html';

interface ContentMap {
    en: string;
    zh: string;
}

const homeContent: ContentMap = {
    en: homeContentEn,
    zh: homeContentZh
};

/**
 * 获取首页介绍内容
 */
export function getHomeContent(): string {
    const lang = getCurrentLanguage();
    return homeContent[lang] || homeContent.en;
}

/**
 * 加载首页介绍内容到指定容器
 * @param containerId 容器元素的 ID
 */
export function loadHomeContent(containerId: string): void {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Container element with id "${containerId}" not found`);
        return;
    }
    
    const content = getHomeContent();
    container.innerHTML = content;
}
