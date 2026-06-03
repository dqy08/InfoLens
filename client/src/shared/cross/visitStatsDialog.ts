/**
 * Visit Stats 弹窗（backend/visit_stats.py：_STATS_PAGE_ORDER / …；周期 visitStatsContract.ts）
 */
import * as d3 from 'd3';
import { showDialog } from '../../shared/ui/dialog';
import { tr } from '../../shared/lang/i18n-lite';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { showVisitStatsTimelineDialog } from './visitStatsTimelineDialog';

const PAGE_ORDER = [
    'index.html',
    'analysis.html',
    'compare.html',
    'chat.html',
    'attribution.html',
    'causal_flow.html',
] as const;

const API_ORDER = [
    'analyze',
    'analyze_semantic',
    'chat',
    'causal_flow',
    'prediction_attribute',
    'prediction_attribute__attribution.html',
    'prediction_attribute__chat.html',
    'prediction_attribute__analysis.html',
] as const;

const OS_ORDER = ['ios', 'android', 'windows', 'macos', 'linux', 'unknown'] as const;

const GEN_ATTR_OPT_ORDER = [
    'layout_linear_arc', 'layout_step_down', 'layout_spiral',
    'causal_flow', 'causal_flow_anim_backward',
    'downstream', 'token_tooltip',
] as const;

/**
 * 上报键更名前写入 Hub 的别名；展示时并入新键。
 * 不再单独统计「开因果流但未点 ↯ 播放」：`propagated_anim` 已移除（动画改由 DAG ↯ 显式触发）。
 */
const GEN_ATTR_OPT_LEGACY_KEYS: Record<string, (typeof GEN_ATTR_OPT_ORDER)[number]> = {
    propagated: 'causal_flow',
    propagated_anim_backward: 'causal_flow_anim_backward',
};

function mergeLegacyGenAttrOptSec(rec: Record<string, number>): Record<string, number> {
    const out = { ...rec };
    for (const [legacy, next] of Object.entries(GEN_ATTR_OPT_LEGACY_KEYS)) {
        const v = out[legacy];
        if (v) {
            out[next] = (out[next] ?? 0) + v;
            delete out[legacy];
        }
    }
    return out;
}

/** gen_attribute.html UI 原文；key 与上报/存储一致 */
const GEN_ATTR_OPT_LABELS: Record<(typeof GEN_ATTR_OPT_ORDER)[number], string> = {
    causal_flow: 'Causal Flow Mode',
    causal_flow_anim_backward: 'Causal Flow Mode / animation backward',
    layout_linear_arc: 'DAG layout/linear_arc',
    layout_step_down: 'DAG layout/step-down',
    layout_spiral: 'DAG layout/spiral',
    downstream: 'Show downstream influence',
    token_tooltip: 'Show token tooltip',
};

type VisitStatsRow = NonNullable<Awaited<ReturnType<TextAnalysisAPI['getVisitStats']>>>;

function orderedKeysGt0(primary: readonly string[], rec: Record<string, number>): string[] {
    const primarySet = new Set(primary);
    const pos = Object.keys(rec).filter((k) => (rec[k] ?? 0) > 0);
    const posSet = new Set(pos);
    const head = primary.filter((k) => posSet.has(k));
    const tail = pos.filter((k) => !primarySet.has(k)).sort();
    return [...head, ...tail];
}

/** 秒 → `1h 2m 3s`（最高 h；省略为 0 的单位；全 0 为 `0s`；负数带负号） */
function formatDurationSec(sec: number): string {
    const sign = sec < 0 ? '-' : '';
    let x = Math.abs(Math.floor(sec));
    const h = Math.floor(x / 3600);
    x %= 3600;
    const m = Math.floor(x / 60);
    const s = x % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s || parts.length === 0) parts.push(`${s}s`);
    return sign + parts.join(' ');
}

function visitStatsHtml(data: VisitStatsRow): string {
    const GREEN = '#22c55e';
    const g = (s: string) => `<span style="color:${GREEN}">${s}</span>`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sb = (Object.keys(data.reset_base ?? {}).length > 0 ? data.reset_base : data.startup_base) ?? {};

    const deltaSuffix = (d: number) => (d !== 0 ? ` ${g(`(${d > 0 ? '+' : ''}${d})`)}` : '');
    const deltaSuffixDuration = (d: number) => {
        if (d === 0) return '';
        const body = formatDurationSec(d);
        const inner = d > 0 ? `+${body}` : body;
        return ` ${g(`(${inner})`)}`;
    };
    const t = data.totals;
    const pg = data.page_sec ?? {};
    const ap = data.api ?? {};
    const os = data.os ?? {};
    const hasBase = Object.keys(sb).length > 0;
    const fmtTotal = (v: number) => (hasBase ? String(v) : 'unknown');
    const linesJoined = (keys: string[], cur: Record<string, number>, base: Record<string, number>): string[] => {
        if (!keys.length) return ['(none)'];
        return keys.map((k) => {
            const v = cur[k] ?? 0;
            return `${esc(k)}: ${fmtTotal(v)}${deltaSuffix(v - (base[k] ?? 0))}`;
        });
    };
    const linesJoinedPageSec = (keys: string[], cur: Record<string, number>, base: Record<string, number>): string[] => {
        if (!keys.length) return ['(none)'];
        return keys.map((k) => {
            const v = cur[k] ?? 0;
            const main = hasBase ? formatDurationSec(v) : 'unknown';
            return `${esc(k)}: ${main}${deltaSuffixDuration(v - (base[k] ?? 0))}`;
        });
    };

    const genAttrOpts = mergeLegacyGenAttrOptSec(data.gen_attr_opt_sec ?? {});
    // sb = reset_base 或 startup_base（见 visitStatsHtml 开头）；delta 对比时对 base 同样做 legacy 合并
    const genAttrOptsBase = mergeLegacyGenAttrOptSec(sb.gen_attr_opt_sec ?? {});
    const genAttrTotalSec = pg['causal_flow.html'] ?? 0;
    const genAttrOptKeys = orderedKeysGt0(GEN_ATTR_OPT_ORDER, genAttrOpts);
    const genAttrOptLines: string[] = genAttrOptKeys.length > 0 && genAttrTotalSec > 0
        ? genAttrOptKeys.map((k) => {
            const v = genAttrOpts[k] ?? 0;
            const pct = Math.round(v / genAttrTotalSec * 100);
            const main = hasBase ? `${formatDurationSec(v)} (${pct}%)` : 'unknown';
            const bv = genAttrOptsBase[k] ?? 0;
            const label = GEN_ATTR_OPT_LABELS[k as (typeof GEN_ATTR_OPT_ORDER)[number]] ?? k;
            return `${esc(label)}: ${main}${deltaSuffixDuration(v - bv)}`;
        })
        : ['(none)'];

    return [
        `Last delta reset: ${esc(data.reset_at ? new Date(data.reset_at).toLocaleString() : 'unknown')}`,
        `Last persisted: ${esc(data.saved_at ? new Date(data.saved_at).toLocaleString() : 'unknown')}`,
        '',
        `[All-time (${g('+ delta since reset')})]`,
        `Page loads: ${fmtTotal(t.page_loads)}${deltaSuffix(t.page_loads - (sb.page_loads ?? 0))}`,
        `Active visits: ${fmtTotal(t.active_visits)}${deltaSuffix(t.active_visits - (sb.active_visits ?? 0))}`,
        `Online: ${data.online_now ?? 'unknown'}`,
        '',
        '[OS]',
        ...linesJoined(orderedKeysGt0(OS_ORDER, os), os, sb.os ?? {}),
        '',
        '[Page active time]',
        ...linesJoinedPageSec(orderedKeysGt0(PAGE_ORDER, pg), pg, sb.page_sec ?? {}),
        '',
        '[API]',
        ...linesJoined(orderedKeysGt0(API_ORDER, ap), ap, sb.api ?? {}),
        '',
        '[causal_flow options (% active time)]',
        ...genAttrOptLines,
    ].join('\n');
}

export async function showVisitStatsDialog(api: TextAnalysisAPI): Promise<void> {
    const fetchAndRender = async (container: d3.Selection<HTMLDivElement, unknown, HTMLElement, any>) => {
        let block = container.select<HTMLDivElement>('div.visit-stats-body');
        if (block.empty()) {
            block = container
                .append('div')
                .attr('class', 'visit-stats-body')
                .style('margin', '0')
                .style('white-space', 'pre-wrap')
                .style('font', 'inherit')
                .style('font-size', '13px');
        } else {
            block.style('opacity', '0');
        }
        try {
            const data = await api.getVisitStats();
            if (!data?.success) throw new Error('bad');
            block.html(visitStatsHtml(data));
        } catch {
            block.text('Failed to load stats.');
        }
        block.style('opacity', '1');
    };

    showDialog({
        title: 'Visit Stats',
        content: (dialog) => {
            // 依赖 showDialog 外壳 DOM：.dialog-content 的 parent 含 .dialog-title（见 dialog.scss）。
            // 将标题与刷新按钮并入同一行；若 dialog 组件改结构，需同步调整此处。
            const shell = d3.select(dialog.node()!.parentElement!);
            const titleText = shell.select('.dialog-title').text();
            shell.select('.dialog-title').remove();
            const titleRow = shell
                .insert('div', '.dialog-content')
                .attr('class', 'dialog-title-row');
            titleRow.append('div').attr('class', 'dialog-title').text(titleText);
            const actions = titleRow.append('div').attr('class', 'dialog-title-actions');

            let scrollBody: d3.Selection<HTMLDivElement, unknown, HTMLElement, any>;
            actions
                .append('button')
                .attr('type', 'button')
                .attr('class', 'refresh-btn')
                .style('font-size', '13px')
                .attr('title', 'Persist current increments then reset delta base')
                .text('Persist and reset delta')
                .on('click', async function () {
                    const btn = d3.select(this);
                    btn.property('disabled', true).style('opacity', '0.4').text('…');
                    try {
                        const res = await api.resetVisitStats();
                        if (!res?.success) throw new Error(res?.error ?? 'failed');
                        await fetchAndRender(scrollBody);
                    } catch (e) {
                        alert(`Reset failed: ${e}`);
                    } finally {
                        btn.property('disabled', false).style('opacity', null).text('Persist and reset delta');
                    }
                });
            actions
                .append('button')
                .attr('type', 'button')
                .attr('class', 'refresh-btn')
                .attr('title', 'Refresh')
                .text('↻')
                .on('click', async function () {
                    const btn = d3.select(this);
                    btn.property('disabled', true).text('…');
                    await fetchAndRender(scrollBody);
                    btn.property('disabled', false).text('↻');
                });

            const wrap = dialog
                .append('div')
                .attr('class', 'dialog-form-container dialog-form-container--fill');
            scrollBody = wrap.append('div').attr('class', 'dialog-scroll-region');
            fetchAndRender(scrollBody);

            shell
                .select('.dialog-buttons')
                .insert('button', '.dialog-button.cancel')
                .attr('type', 'button')
                .attr('class', 'dialog-button cancel')
                .attr('title', 'Visit stats timeline (local time)')
                .text('Timeline')
                .on('click', () => {
                    void showVisitStatsTimelineDialog(api);
                });

            return { focus: () => {} };
        },
        cancelText: tr('Exit'),
        confirmText: null,
        width: 'clamp(340px, 90vw, 460px)',
    });
}
