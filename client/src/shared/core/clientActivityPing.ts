import URLHandler from './URLHandler';
import { AdminManager } from '../cross/adminManager';

const S = 10, FIRST = 2;

let _pageOptsGetter: (() => Record<string, boolean>) | undefined;
/** gen_attribute.html 等页面注册当前选项状态，供心跳上报时附带。 */
export function setPageOptsGetter(fn: () => Record<string, boolean>): void {
    _pageOptsGetter = fn;
}

export type ReportedClientOs = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown';

/** UA 粗略归类；仅在首轮心跳（cum === FIRST）顺带上报一次。 */
function detectInitialClientOs(): ReportedClientOs {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    if (/iPad|iPhone|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const p = nav?.platform ?? '';
    const tp = nav && typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    // iPadOS 13+ 桌面 UA 常为 Macintosh
    if (p === 'MacIntel' && tp > 1) return 'ios';
    if (/Win/i.test(ua)) return 'windows';
    if (/Mac/i.test(ua)) return 'macos';
    if (/Linux/i.test(ua)) return 'linux';
    return 'unknown';
}

export function initClientActivityPing(apiPrefix: string | null | undefined): void {
    if (typeof window === 'undefined') return;
    if (AdminManager.getInstance().isInAdminMode()) return;
    const u = `${apiPrefix || URLHandler.basicURL()}/api/client-activity`;
    let n = 0, reportedTotal = 0, id: number | undefined;
    const vis = () => document.visibilityState === 'visible';
    const tick = () => {
        if (!vis()) return;
        n += 1;
        if (n !== FIRST && n % S !== 0) return;
        const cum = n;
        const delta_active_sec = Math.max(cum - reportedTotal, 0);
        const payload: Record<string, unknown> = {
            page_path: location.pathname + location.search,
            total_active_sec: cum,
            delta_active_sec,
        };
        if (cum === FIRST) payload.client_os = detectInitialClientOs();
        if (_pageOptsGetter) {
            const active = Object.fromEntries(Object.entries(_pageOptsGetter()).filter(([, v]) => v));
            if (Object.keys(active).length > 0) payload.page_opts = active;
        }
        const body = JSON.stringify(payload);
        void fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
            .then((r) => { if (r.ok) reportedTotal = cum; })
            .catch(() => {});
    };
    const sync = () => {
        if (id !== undefined) { clearInterval(id); id = undefined; }
        if (vis()) id = window.setInterval(tick, 1000);
    };
    document.addEventListener('visibilitychange', sync);
    sync();
}
