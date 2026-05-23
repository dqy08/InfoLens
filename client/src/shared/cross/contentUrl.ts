/** 三页 Cached history 共用的 URL 参数名 */
export const DEFAULT_CONTENT_URL_PARAM = 'content';

/** LLM Causal Flow 打包 demo：参数值为文件名（不含 .json） */
export const DEFAULT_DEMO_URL_PARAM = 'demo';

function readUrlParam(paramName: string): string | null {
    try {
        const v = new URL(window.location.href).searchParams.get(paramName);
        return v != null && v.length > 0 ? v : null;
    } catch {
        return null;
    }
}

export function readContentUrlParam(paramName: string = DEFAULT_CONTENT_URL_PARAM): string | null {
    return readUrlParam(paramName);
}

export function replaceContentUrlParam(
    value: string | null,
    paramName: string = DEFAULT_CONTENT_URL_PARAM,
    logLabel?: string
): void {
    replaceUrlParam(value, paramName, logLabel ?? 'contentUrl');
}

export function readDemoUrlParam(paramName: string = DEFAULT_DEMO_URL_PARAM): string | null {
    return readUrlParam(paramName);
}

function replaceUrlParam(value: string | null, paramName: string, logLabel: string): void {
    try {
        const u = new URL(window.location.href);
        u.searchParams.delete(paramName);
        if (value) {
            u.searchParams.set(paramName, value);
        }
        window.history.replaceState(null, '', u.toString());
    } catch (e: unknown) {
        console.warn(`[${logLabel}] URL sync failed:`, e);
    }
}

export function replaceDemoUrlParam(
    value: string | null,
    paramName: string = DEFAULT_DEMO_URL_PARAM,
    logLabel?: string
): void {
    replaceUrlParam(value, paramName, logLabel ?? 'contentUrl:demo');
}

export type RunContentUrlHydrateOptions<T> = {
    readRaw: () => string | null;
    fetchEntry: (raw: string) => Promise<T | undefined>;
    /** 缺省：仅判断 entry 非 undefined/null */
    isValid?: (entry: T) => boolean;
    /** 第二参为 URL 中的原始 content 值（IndexedDB 条目的短哈希键） */
    apply: (entry: T, rawContentKey: string) => void | Promise<void>;
    onMissing: () => void | Promise<void>;
    onApplyError?: (error: unknown) => void | Promise<void>;
};

export async function runContentUrlHydrate<T>(options: RunContentUrlHydrateOptions<T>): Promise<void> {
    const raw = options.readRaw();
    if (!raw) return;
    const entry = await options.fetchEntry(raw);
    const ok =
        entry != null && (options.isValid ? options.isValid(entry) : true);
    if (!ok) {
        await Promise.resolve(options.onMissing());
        return;
    }
    try {
        await options.apply(entry, raw);
    } catch (e: unknown) {
        if (options.onApplyError) {
            await Promise.resolve(options.onApplyError(e));
        } else {
            throw e;
        }
    }
}
