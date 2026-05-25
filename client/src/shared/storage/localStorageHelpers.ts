/** 薄层 localStorage 封装：统一 try/catch，不改变各 key 的存储格式与 default 语义。 */

export type LsBoolEncoding = 'true' | '1';

export function lsGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function lsSet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* quota / private mode */
    }
}

/** 写入失败时返回 caught 值（供需自定义错误处理的调用方，如 semanticResultCache）。 */
export function lsSetCatch(key: string, value: string): unknown | undefined {
    try {
        localStorage.setItem(key, value);
        return undefined;
    } catch (e) {
        return e;
    }
}

export function lsRemove(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        /* ignore */
    }
}

/**
 * @param defaultWhenNull key 不存在或读取失败时的返回值
 * @param encoding `'true'`: 存 `'true'/'false'`；`'1'`: 存 `'1'/'0'`
 */
export function lsReadBool(
    key: string,
    defaultWhenNull: boolean,
    options?: { encoding?: LsBoolEncoding },
): boolean {
    const encoding = options?.encoding ?? 'true';
    const v = lsGet(key);
    if (v === null) return defaultWhenNull;
    return encoding === '1' ? v === '1' : v === 'true';
}

export function lsWriteBool(key: string, value: boolean, encoding: LsBoolEncoding = 'true'): void {
    lsSet(key, encoding === '1' ? (value ? '1' : '0') : value ? 'true' : 'false');
}

export type LsReadNumberOptions = {
    parse?: 'int' | 'float';
    clamp?: (n: number) => number;
    validate?: (n: number) => boolean;
};

export function lsReadNumber(
    key: string,
    defaultValue: number,
    options?: LsReadNumberOptions,
): number {
    const v = lsGet(key);
    if (v === null) return defaultValue;
    const n = options?.parse === 'float' ? parseFloat(v) : parseInt(v, 10);
    if (!Number.isFinite(n)) return defaultValue;
    if (options?.validate && !options.validate(n)) return defaultValue;
    return options?.clamp ? options.clamp(n) : n;
}

export function lsWriteNumber(key: string, value: number): void {
    lsSet(key, String(value));
}

export function lsReadEnum<T extends string>(
    key: string,
    allowed: readonly T[],
    defaultValue: T,
): T {
    const v = lsGet(key);
    if (v !== null && (allowed as readonly string[]).includes(v)) return v as T;
    return defaultValue;
}

export function lsWriteString(key: string, value: string): void {
    lsSet(key, value);
}
