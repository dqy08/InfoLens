/**
 * WORKAROUND（仅作降级，非主路径）
 *
 * 部分浏览器（尤其 iPhone Safari）对普通元素 {@link HTMLElement.requestFullscreen} 不支持或会拒绝。
 * 主交互仍是标准 Fullscreen API（见 {@link runDagFullscreenToggleWithPseudoWorkaround} 内优先 `requestFullscreen`）；
 * 仅当原生不可用 / `catch` 时，委托给 `cssPseudoFullscreen.ts` 做 CSS fixed 伪全屏。
 *
 * 与 DAG 图布局、LMF 文本、zoom 等无关 —— 只影响 results 表面是否铺满视口。
 */

import {
    cssPseudoFullscreenEnter,
    cssPseudoFullscreenExit,
    cssPseudoFullscreenIsActive,
    CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT,
} from '../../../shared/ui/cssPseudoFullscreen';

export { CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT };

/** #results 是否处于「展开」：原生全屏到该元素，或伪全屏激活到该元素 */
export function dagResultsSurfaceFullscreenExpanded(rootEl: HTMLElement): boolean {
    return document.fullscreenElement === rootEl || cssPseudoFullscreenIsActive(rootEl);
}

/** 组件卸载时调用；无伪全屏时为空操作 */
export function detachDagPseudoFullscreenIfPresent(rootEl: HTMLElement): void {
    cssPseudoFullscreenExit(rootEl);
}

/** 尝试进入 rootEl 原生全屏；不支持或失败时降级伪全屏。 */
async function enterRootElFullscreen(rootEl: HTMLElement): Promise<void> {
    if (typeof rootEl.requestFullscreen !== 'function') {
        cssPseudoFullscreenEnter(rootEl);
        return;
    }
    try {
        await rootEl.requestFullscreen();
    } catch {
        cssPseudoFullscreenEnter(rootEl);
    }
}

/**
 * 处理全屏按钮一次点击：先走标准 API，失败或未实现时再走伪全屏。
 * 不负责刷新按钮图标 / `syncSvgSize` —— 调用方在 await 后统一 `refreshFullscreenChrome()` 即可。
 */
export async function runDagFullscreenToggleWithPseudoWorkaround(options: {
    rootEl: HTMLElement;
    onNativeExitFailure: (e: unknown) => void;
}): Promise<void> {
    const { rootEl, onNativeExitFailure } = options;

    if (dagResultsSurfaceFullscreenExpanded(rootEl)) {
        if (document.fullscreenElement === rootEl) {
            try {
                await document.exitFullscreen();
            } catch (e: unknown) {
                onNativeExitFailure(e);
            }
        }
        if (cssPseudoFullscreenIsActive(rootEl)) {
            cssPseudoFullscreenExit(rootEl);
        }
        return;
    }

    if (document.fullscreenElement) {
        // 其他元素已全屏：先退出，退出失败则放弃（不能在另一元素全屏时再进伪全屏，状态会不一致）
        try {
            await document.exitFullscreen();
        } catch (e: unknown) {
            onNativeExitFailure(e);
            return;
        }
    }

    await enterRootElFullscreen(rootEl);
}
