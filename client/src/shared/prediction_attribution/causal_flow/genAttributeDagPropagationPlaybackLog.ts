/** 浏览器控制台调试前缀；过滤：`dag-prop`。 */
const DAG_PROPAGATION_PLAYBACK_LOG = '[dag-prop]';

/** playback 日志最小列宽（不足则填充；超出不截断）。 */
export const DAG_PROP_LOG_W = {
    event: 7,
    frame: 6,
    token: 10,
    weight: 7,
    dwell: 5,
    focus: 10,
    direction: 8,
    int3: 3,
} as const;

/** localStorage：`localStorage.setItem('info_radar.dag_propagation_playback_log', '1')` */
export const DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY = 'info_radar.dag_propagation_playback_log';

export function isDagPropagationPlaybackLogEnabled(): boolean {
    if (typeof globalThis === 'undefined') return false;
    const g = globalThis as typeof globalThis & { __DAG_PROPAGATION_PLAYBACK_LOG__?: boolean };
    if (g.__DAG_PROPAGATION_PLAYBACK_LOG__ === true) return true;
    try {
        return localStorage.getItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY) === '1';
    } catch {
        return false;
    }
}

/** 控制台：`infoRadar.dagPropagationPlaybackLog(true)` */
export function setDagPropagationPlaybackLogEnabled(enabled: boolean): void {
    if (typeof globalThis !== 'undefined') {
        (globalThis as typeof globalThis & { __DAG_PROPAGATION_PLAYBACK_LOG__?: boolean }).__DAG_PROPAGATION_PLAYBACK_LOG__ =
            enabled;
    }
    try {
        if (enabled) localStorage.setItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY, '1');
        else localStorage.removeItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY);
    } catch {
        /* private mode / disabled storage */
    }
}

export function logDagPropagationPlaybackLine(line: string): void {
    if (!isDagPropagationPlaybackLogEnabled()) return;
    console.log(`${DAG_PROPAGATION_PLAYBACK_LOG} ${line}`);
}

if (typeof window !== 'undefined') {
    const w = window as Window & { infoRadar?: Record<string, unknown> };
    w.infoRadar = { ...w.infoRadar, dagPropagationPlaybackLog: setDagPropagationPlaybackLogEnabled };
}

export function dagPropLogFmtToken(label: string | null): string {
    return label ?? '?';
}

export function dagPropLogFmtWeight(w: number | undefined): string {
    return w != null ? w.toFixed(4) : '-';
}

export function dagPropLogPad(value: string, width: number): string {
    return value.length >= width ? value : value.padEnd(width, ' ');
}

export function dagPropLogPadInt(value: number, width: number): string {
    const s = String(value);
    return s.length >= width ? s : s.padStart(width, ' ');
}

export function dagPropLogPadWeight(w: number | undefined): string {
    return dagPropLogPad(dagPropLogFmtWeight(w), DAG_PROP_LOG_W.weight);
}

export type DagPropagationPlaybackLogNodeShare = { id: string; share: number };

export function nodesAtNodeShareTotalForPlaybackLog(
    nodeShareById: ReadonlyMap<string, number>,
    total: number,
    options?: {
        excludeFocusId?: string;
        onlyNodeIds?: ReadonlySet<string>;
    },
): DagPropagationPlaybackLogNodeShare[] {
    const out: DagPropagationPlaybackLogNodeShare[] = [];
    for (const [nodeId, share] of nodeShareById) {
        if (options?.excludeFocusId != null && nodeId === options.excludeFocusId) continue;
        if (options?.onlyNodeIds != null && !options.onlyNodeIds.has(nodeId)) continue;
        if (share === total) out.push({ id: nodeId, share });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}

export function dagPropLogFmtNodeShareList(
    entries: readonly DagPropagationPlaybackLogNodeShare[],
    tokenLabelOf: (id: string) => string | null,
): string {
    if (entries.length === 0) return '-';
    return entries
        .map((e) => `${dagPropLogFmtToken(tokenLabelOf(e.id))}(${dagPropLogPadWeight(e.share)})`)
        .join(', ');
}
