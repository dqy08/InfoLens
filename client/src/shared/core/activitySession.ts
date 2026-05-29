/**
 * 各页入口注册 isBusy；心跳 tick 用 isSessionActive() = 可见 || getter()。
 */

let pageBusyGetter: (() => boolean) | undefined;

export function registerPageBusy(getter: () => boolean): void {
    pageBusyGetter = getter;
}

export function isSessionActive(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        return true;
    }
    return pageBusyGetter?.() ?? false;
}
