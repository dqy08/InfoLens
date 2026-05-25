/** 语义匹配度阈值：用户可配置，持久化到 localStorage，与 Semantic analysis 同方式 */
import { SEMANTIC_MATCH_THRESHOLD } from '../core/constants';
import { lsGet, lsSet } from '../storage/localStorageHelpers';

const KEY = 'info_radar_semantic_match_threshold';

export function getSemanticMatchThreshold(): number {
    const v = lsGet(KEY);
    if (v == null) return SEMANTIC_MATCH_THRESHOLD;
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : SEMANTIC_MATCH_THRESHOLD;
}

export function setSemanticMatchThreshold(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    lsSet(KEY, String(clamped));
}
