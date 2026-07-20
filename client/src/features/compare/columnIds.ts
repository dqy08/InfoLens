/**
 * 列 ID：`id` 为规范化路径（数据 key / data-column-id）；
 * `safeId` 为 djb2+base36 哈希，用于 HTML 元素 id，避免特殊字符冲突。
 */
export function toSafeId(id: string): string {
    if (!id || typeof id !== 'string' || id.length === 0) {
        return 'empty';
    }

    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
        return 'empty';
    }

    let hash = 5381;
    for (let i = 0; i < trimmedId.length; i++) {
        hash = ((hash << 5) + hash) + trimmedId.charCodeAt(i);
    }

    return Math.abs(hash).toString(36) || 'empty';
}

/** 从 histogram source（如 stats_frac_xxx / stats_byte_frac_xxx）解析 safeId 与类型 */
export function parseHistogramSource(
    source?: string
): { safeId: string; histogramType: 'token' | 'byte' } | null {
    if (!source) {
        return null;
    }

    const bytePrefix = 'stats_byte_frac';
    const tokenPrefix = 'stats_frac';

    if (source.startsWith(bytePrefix)) {
        const safeId = source.substring(bytePrefix.length).replace(/^_/, '');
        return safeId ? { safeId, histogramType: 'byte' } : null;
    }

    if (source.startsWith(tokenPrefix)) {
        const safeId = source.substring(tokenPrefix.length).replace(/^_/, '');
        return safeId ? { safeId, histogramType: 'token' } : null;
    }

    return null;
}

export function findColumnBySafeId<T>(
    columnsData: Map<string, T>,
    safeId: string
): { id: string; columnData: T } | null {
    if (!safeId) {
        return null;
    }

    for (const [id, columnData] of columnsData.entries()) {
        if (toSafeId(id) === safeId) {
            return { id, columnData };
        }
    }

    return null;
}
