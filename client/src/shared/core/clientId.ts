/**
 * 产品级匿名 client_id：只读门面签发的 Cookie `il_aid`（Domain=.info-lens.app）。
 * 官网自身不签发，没装插件的访客不会被种 Cookie。
 */

const COOKIE_NAME = 'il_aid';
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 已有 id 则返回，否则 null（不新建、不写 Cookie）。 */
export function readClientId(): string | null {
    if (typeof document === 'undefined') return null;
    for (const part of document.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== COOKIE_NAME) continue;
        let raw = part.slice(i + 1).trim();
        try {
            raw = decodeURIComponent(raw);
        } catch {
            /* 原样使用 */
        }
        return UUID_RE.test(raw) ? raw.toLowerCase() : null;
    }
    return null;
}
