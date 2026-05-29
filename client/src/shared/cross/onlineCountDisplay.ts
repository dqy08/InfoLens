/**
 * 页头在线人数（由 client-activity 响应更新 #online_count_value）
 */

const VALUE_ID = 'online_count_value';

export function initOnlineCountDisplay(): void {
    const el = document.getElementById(VALUE_ID);
    if (el && !el.textContent?.trim()) el.textContent = '—';
}

export function applyOnlineCount(n: unknown): void {
    const el = document.getElementById(VALUE_ID);
    if (!el) return;
    el.textContent =
        typeof n === 'number' && Number.isFinite(n) ? String(n) : '—';
}
