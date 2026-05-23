/**
 * WORKAROUND：CSS 伪全屏（fixed + 锁 body 滚动）
 *
 * 不参与 Fullscreen API。供「原生 `requestFullscreen` 不可用或拒绝」时降级使用；
 * 业务层应始终先尝试标准 API，再把本模块当作兜底（见 `genAttributeDagFullscreenWorkaround.ts`）。
 *
 * 样式类名 {@link CSS_PSEUDO_FULLSCREEN_TARGET_CLASS} 须与页面 SCSS 一致。
 */

/** 须与 gen_attribute.scss 中 WORKAROUND 段落的选择器一致 */
export const CSS_PSEUDO_FULLSCREEN_TARGET_CLASS = 'css-pseudo-fullscreen-target';

const BODY_LOCK_CLASS = 'css-pseudo-fullscreen-body-lock';

/** 伪全屏进/出时派发（`fullscreenchange` 不会为此触发） */
export const CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT = 'css-pseudo-fullscreen-change';

let activeTarget: HTMLElement | null = null;
let escapeListener: ((e: KeyboardEvent) => void) | null = null;

function teardownEscape(): void {
    if (escapeListener) {
        document.removeEventListener('keydown', escapeListener);
        escapeListener = null;
    }
}

function notifyChange(): void {
    document.dispatchEvent(new CustomEvent(CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT));
}

export function cssPseudoFullscreenIsActive(el?: HTMLElement): boolean {
    if (!activeTarget) return false;
    return el === undefined ? true : activeTarget === el;
}

export function cssPseudoFullscreenEnter(el: HTMLElement): void {
    if (activeTarget === el) return;
    if (activeTarget && activeTarget !== el) cssPseudoFullscreenExit();
    activeTarget = el;
    activeTarget.classList.add(CSS_PSEUDO_FULLSCREEN_TARGET_CLASS);
    document.body.classList.add(BODY_LOCK_CLASS);
    teardownEscape();
    // 原生全屏时浏览器自己处理 Escape；伪全屏不走 Fullscreen API，须自行监听。
    escapeListener = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            cssPseudoFullscreenExit();
        }
    };
    document.addEventListener('keydown', escapeListener);
    notifyChange();
}

export function cssPseudoFullscreenExit(el?: HTMLElement): void {
    if (!activeTarget) return;
    if (el !== undefined && activeTarget !== el) return;
    activeTarget.classList.remove(CSS_PSEUDO_FULLSCREEN_TARGET_CLASS);
    document.body.classList.remove(BODY_LOCK_CLASS);
    activeTarget = null;
    teardownEscape();
    notifyChange();
}
