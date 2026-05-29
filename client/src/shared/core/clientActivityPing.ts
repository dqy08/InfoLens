import URLHandler from './URLHandler';
import { AdminManager } from '../cross/adminManager';
import { applyOnlineCount } from '../cross/onlineCountDisplay';
import { isSessionActive } from './activitySession';

/** 活跃秒采样间隔 */
const TICK_MS = 1000;
/** 上报档位：累计活跃秒达到这些值时 POST */
const FIRST_REPORT_SEC = 2;
const REPORT_INTERVAL_SEC = 10;

let _pageOptsGetter: (() => Record<string, boolean>) | undefined;
/** gen_attribute.html 等页面注册当前选项状态，供心跳上报时附带。 */
export function setPageOptsGetter(fn: () => Record<string, boolean>): void {
    _pageOptsGetter = fn;
}

export type ReportedClientOs = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown';

/** UA 粗略归类；仅在首轮心跳顺带上报一次。 */
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

function applyOnlineFromActivityResponse(r: Response): void {
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;
    void r
        .clone()
        .json()
        .then((data: { online_now?: unknown }) => {
            if (data && 'online_now' in data) applyOnlineCount(data.online_now);
        })
        .catch(() => {});
}

/** 累计活跃秒为 2、10、20… 时上报 */
function shouldReportAtSec(totalActiveSec: number): boolean {
    return totalActiveSec === FIRST_REPORT_SEC || totalActiveSec % REPORT_INTERVAL_SEC === 0;
}

export function initClientActivityPing(apiPrefix: string | null | undefined): void {
    if (typeof window === 'undefined') return;
    const admin = AdminManager.getInstance();
    const endpoint = `${apiPrefix || URLHandler.basicURL()}/api/client-activity`;
    let totalActiveSec = 0;
    let lastReportedSec = 0;

    const postActivity = (includeClientOs: boolean) => {
        const deltaActiveSec = Math.max(totalActiveSec - lastReportedSec, 0);
        const payload: Record<string, unknown> = {
            page_path: location.pathname + location.search,
            total_active_sec: totalActiveSec,
            delta_active_sec: deltaActiveSec,
        };
        if (includeClientOs) payload.client_os = detectInitialClientOs();
        if (_pageOptsGetter) {
            const active = Object.fromEntries(Object.entries(_pageOptsGetter()).filter(([, v]) => v));
            if (Object.keys(active).length > 0) payload.page_opts = active;
        }
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const adminToken = admin.isInAdminMode() ? admin.getAdminToken() : null;
        if (adminToken) headers['X-Admin-Token'] = adminToken;
        void fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            keepalive: true,
        })
            .then((r) => {
                applyOnlineFromActivityResponse(r);
                if (r.ok) lastReportedSec = totalActiveSec;
            })
            .catch(() => {});
    };

    const tick = () => {
        if (!isSessionActive()) return;
        totalActiveSec += 1;
        if (!shouldReportAtSec(totalActiveSec)) return;
        postActivity(totalActiveSec === FIRST_REPORT_SEC);
    };

    window.setInterval(tick, TICK_MS);
}
