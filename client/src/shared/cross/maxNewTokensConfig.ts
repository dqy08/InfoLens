/** 与 backend/core/completion_generator.py completion_max_token_length 一致。 */
export const SITE_MAX_NEW_TOKENS = 300;

export const DEFAULT_MAX_NEW_TOKENS = 200;

export type MaxNewTokensParseErrorCode = 'empty' | 'invalid' | 'exceeds_site';

export class MaxNewTokensParseError extends Error {
    readonly code: MaxNewTokensParseErrorCode;

    constructor(code: MaxNewTokensParseErrorCode) {
        super(code);
        this.code = code;
        this.name = 'MaxNewTokensParseError';
    }
}

export function parseMaxNewTokens(raw: string, admin: boolean): number {
    const t = raw.trim();
    if (t === '') {
        throw new MaxNewTokensParseError('empty');
    }
    if (!/^\d+$/.test(t)) {
        throw new MaxNewTokensParseError('invalid');
    }
    const n = parseInt(t, 10);
    if (n <= 0) {
        throw new MaxNewTokensParseError('invalid');
    }
    if (!admin && n > SITE_MAX_NEW_TOKENS) {
        throw new MaxNewTokensParseError('exceeds_site');
    }
    return n;
}

export function isMaxNewTokensRawValid(raw: string, admin: boolean): boolean {
    try {
        parseMaxNewTokens(raw, admin);
        return true;
    } catch {
        return false;
    }
}

export function ensureMaxNewTokensInputNotEmpty(input: HTMLInputElement | null): void {
    if (input && input.value.trim() === '') {
        input.value = String(DEFAULT_MAX_NEW_TOKENS);
    }
}

/** 非管理员时 HTML max=站点上限；管理员去掉 max 以便填更大数字。 */
export function syncMaxNewTokensInputSiteMax(
    input: HTMLInputElement | null,
    admin: boolean
): void {
    if (!input) return;
    if (admin) {
        input.removeAttribute('max');
    } else {
        input.max = String(SITE_MAX_NEW_TOKENS);
    }
}

type TrFn = (text: string) => string;
type TrfFn = (text: string, vars: Record<string, string | number>) => string;

export function formatMaxNewTokensParseError(
    code: MaxNewTokensParseErrorCode,
    tr: TrFn,
    trf: TrfFn
): string {
    if (code === 'exceeds_site') {
        return trf('Max new tokens must not exceed {limit}', { limit: SITE_MAX_NEW_TOKENS });
    }
    return tr('Max new tokens must be a positive integer');
}

/** blur/change 时校验；非法则 alert、修正输入框，返回是否有效。 */
export function finalizeMaxNewTokensInput(
    input: HTMLInputElement | null,
    admin: boolean,
    onAlert: (message: string) => void,
    tr: TrFn,
    trf: TrfFn
): boolean {
    ensureMaxNewTokensInputNotEmpty(input);
    if (!input) return false;
    try {
        parseMaxNewTokens(input.value, admin);
        return true;
    } catch (e) {
        if (!(e instanceof MaxNewTokensParseError)) throw e;
        onAlert(formatMaxNewTokensParseError(e.code, tr, trf));
        input.value =
            e.code === 'exceeds_site'
                ? String(SITE_MAX_NEW_TOKENS)
                : String(DEFAULT_MAX_NEW_TOKENS);
        return false;
    }
}
