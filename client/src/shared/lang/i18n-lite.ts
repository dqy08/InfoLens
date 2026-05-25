/**
 * 最简国际化方案 (方案 B)
 * 
 * 设计原则：
 * 1. 英文是 source of truth，直接写在代码里
 * 2. 其它语言通过翻译表覆盖
 * 3. 不引入第三方 i18n 框架
 * 4. 支持未来平滑升级到标准 i18n
 */

import { translations } from './translations';
import { lsGet, lsSet } from '../storage/localStorageHelpers';

export type Language = 'en' | 'zh';

// 当前语言状态（从 localStorage 恢复，默认为 en）
let currentLanguage: Language = 'en';

// 初始化：从 localStorage 读取语言设置
const LANG_STORAGE_KEY = 'app_language';
const storedLang = lsGet(LANG_STORAGE_KEY);
if (storedLang === 'en' || storedLang === 'zh') {
    currentLanguage = storedLang;
}

// 跨标签页语言同步：监听其他页面对语言的修改
const storageListener = (event: StorageEvent) => {
    if (event.key !== LANG_STORAGE_KEY) {
        return;
    }
    const newLang = event.newValue;
    if (newLang === 'en' || newLang === 'zh') {
        // 语言变化时刷新页面以应用新语言
        // （因为 data-i18n 只在页面加载时执行一次）
        location.reload();
    }
};

// 自动启用跨标签页同步
window.addEventListener('storage', storageListener);

/**
 * 翻译函数
 * @param text 英文原文（source of truth）
 * @returns 翻译后的文本，如果没有翻译则返回原文
 */
export function tr(text: string): string {
    if (currentLanguage === 'en') {
        return text;
    }
    
    // 非英文：查找翻译表
    const langTranslations = translations[currentLanguage];
    if (langTranslations && langTranslations[text]) {
        return langTranslations[text];
    }
    
    // 找不到翻译，fallback 到原文
    return text;
}

function escapeRegExpLiteral(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 翻译 + 模板变量替换（{name} / {count} 等）
 *
 * 注意：变量替换发生在翻译之后，确保翻译表里的占位符也能被替换。
 */
export function trf(
    text: string,
    vars: Record<string, string | number>
): string {
    let out = tr(text);
    for (const [key, value] of Object.entries(vars)) {
        const pattern = new RegExp(`\\{${escapeRegExpLiteral(key)}\\}`, 'g');
        out = out.replace(pattern, String(value));
    }
    return out;
}

/**
 * 获取当前语言
 */
export function getCurrentLanguage(): Language {
    return currentLanguage;
}

/**
 * 设置语言
 * @param lang 目标语言
 */
export function setLanguage(lang: Language): void {
    currentLanguage = lang;
    lsSet(LANG_STORAGE_KEY, lang);
}

/**
 * 切换语言（en <-> zh）
 */
export function toggleLanguage(): Language {
    const newLang: Language = currentLanguage === 'en' ? 'zh' : 'en';
    setLanguage(newLang);
    return newLang;
}

/**
 * 初始化页面国际化
 * 遍历所有带 data-i18n 属性的元素，根据当前语言翻译
 * 
 * data-i18n 自动从 HTML 读取英文内容作为翻译 key，无需重复写
 * 
 * 用法：
 * <button data-i18n>Analyze</button>
 * <button title="Save to local file" data-i18n="text,title">Save to local</button>
 * <button title="Toggle dark mode" data-i18n="title">🌙</button>
 */
export function initI18n(): void {
    if (currentLanguage === 'en') {
        return; // 英文不需要翻译
    }

    // 遍历所有带 data-i18n 属性的元素
    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const i18nAttr = element.getAttribute('data-i18n');
        
        // 默认翻译 text，支持逗号分隔的多属性：text,title,placeholder
        const attrs = !i18nAttr || i18nAttr === 'text' 
            ? ['text'] 
            : i18nAttr.split(',').map(s => s.trim());

        attrs.forEach((attr) => {
            let key: string | null = null;
            
            if (attr === 'text') {
                key = element.textContent?.trim() || null;
                if (key) {
                    element.textContent = tr(key);
                }
            } else if (attr === 'html') {
                key = element.innerHTML?.trim() || null;
                if (key) {
                    element.innerHTML = tr(key);
                }
            } else {
                key = element.getAttribute(attr);
                if (key) {
                    element.setAttribute(attr, tr(key));
                }
            }
        });
    });
}

/**
 * 迁移到标准 i18n 的接口兼容性说明：
 * 
 * 未来如果需要迁移到 i18next 等标准 i18n 框架：
 * 
 * 1. 替换 tr() 函数：
 *    import { t as tr } from 'i18next';
 * 
 * 2. 转换翻译表格式：
 *    从当前的扁平结构：
 *      { "Start analysis": "开始分析" }
 *    转换为标准格式：
 *      { "translation": { "Start analysis": "开始分析" } }
 * 
 * 3. 初始化 i18next：
 *    i18next.init({
 *      lng: getCurrentLanguage(),
 *      resources: {
 *        en: { translation: {} },
 *        zh: { translation: translations.zh }
 *      }
 *    });
 * 
 * 4. 业务代码无需修改：
 *    所有使用 tr() 的地方保持不变
 */
