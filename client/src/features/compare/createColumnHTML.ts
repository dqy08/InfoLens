import { tr } from '../../shared/lang/i18n-lite';
import { toSafeId } from './columnIds';

/** 单个 demo 列的 HTML（id 属性用 safeId，data-column-id 用原始 id） */
export function createColumnHTML(id: string, demoName: string): string {
    const safeId = toSafeId(id);
    const columnId = `compare-column-${safeId}`;
    const statsId = `stats_demo_${safeId}`;
    const headerId = `compare-header-${safeId}`;
    const metricsId = `text_metrics_${safeId}`;
    const errorId = `error_${safeId}`;
    const statsFracId = `stats_frac_${safeId}`;
    const statsByteFracId = `stats_byte_frac_${safeId}`;
    const statsProgressId = `stats_surprisal_progress_${safeId}`;
    const textRenderId = `text_render_${safeId}`;

    return `
            <div id="${columnId}" class="compare-column" data-column-id="${id}">
                <div id="${headerId}" class="compare-header">
                    <div class="column-actions-row">
                        <button class="move-to-first-btn" title="${tr('Move to leftmost')}">⏮</button>
                        <button class="move-left-btn" title="${tr('Move left')}">◀</button>
                        <button class="delete-btn" title="${tr('Delete')}">×</button>
                        <button class="move-right-btn" title="${tr('Move right')}">▶</button>
                        <button class="move-to-last-btn" title="${tr('Move to rightmost')}">⏭</button>
                    </div>
                    <div class="column-title">${demoName}</div>
                </div>
                <div id="${errorId}" class="compare-error" style="display: none; color: var(--error-color, #f44336); padding: 10px; margin-bottom: 10px; background-color: var(--error-bg, rgba(244, 67, 54, 0.1)); border-radius: 4px;"></div>
                <div id="${metricsId}" class="text-metrics is-hidden">
                    <div class="text-metrics-primary">
                        <span id="metric_bytes_${safeId}">0 B</span>
                        <span class="text-metrics-divider">|</span>
                        <span id="metric_chars_${safeId}">${tr('0 chars')}</span>
                        <span class="text-metrics-divider">|</span>
                        <span id="metric_tokens_${safeId}">0 tokens</span>
                    </div>
                    <div id="metric_total_surprisal_${safeId}" class="text-metrics-secondary">${tr('total information = 0 bits')}</div>
                    <div id="metric_model_${safeId}" class="text-metrics-secondary is-hidden">model: </div>
                </div>
                <div id="${statsId}" class="stats" style="text-align:center;">
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="token_histogram_title_${safeId}"></div>
                        <svg id="${statsFracId}"></svg>
                    </div>
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="byte_histogram_title_${safeId}"></div>
                        <svg id="${statsByteFracId}"></svg>
                    </div>
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="surprisal_progress_title_${safeId}"></div>
                        <svg id="${statsProgressId}"></svg>
                    </div>
                </div>
                <div id="${textRenderId}" class="compare-text-render is-hidden"></div>
            </div>
        `;
}
