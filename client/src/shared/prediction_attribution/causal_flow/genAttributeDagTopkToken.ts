import type { FrontendToken } from '../../../shared/api/GLTR_API';
import type { TokenGenStep } from './tokenGenAttributionRunner';

/**
 * 将单步生成归因结果转为与 {@link ToolTip} / Top‑K 条形图一致的 {@link FrontendToken}。
 * `debug_info.topk_*` 来自 `/api/prediction-attribute`，与语义分析同源。
 */
export function frontendTokenFromGenAttrStep(step: TokenGenStep): FrontendToken | null {
    const raw = step.token;
    if (!raw) return null;

    const start = step.context.length;
    const end = start + raw.length;
    const prob = step.response.target_prob;
    const real_topk =
        prob != null && Number.isFinite(prob) ? ([0, prob] as [number, number]) : undefined;

    const dbg = step.response.debug_info;
    let pred_topk: [string, number][] = [];
    if (dbg?.topk_tokens?.length && dbg?.topk_probs?.length) {
        const n = Math.min(dbg.topk_tokens.length, dbg.topk_probs.length);
        for (let i = 0; i < n; i++) {
            const t = dbg.topk_tokens[i]!;
            const p = dbg.topk_probs[i]!;
            if (typeof t === 'string' && typeof p === 'number' && Number.isFinite(p)) {
                pred_topk.push([t, p]);
            }
        }
    }

    return {
        offset: [start, end],
        raw,
        pred_topk,
        ...(real_topk !== undefined ? { real_topk } : {}),
    };
}
