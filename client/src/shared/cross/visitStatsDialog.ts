/**
 * Visit Stats 弹窗（backend/visit_stats.py：_STATS_PAGE_ORDER / _STATS_API_ORDER / _STATS_OS_ORDER）
 */
import * as d3 from 'd3';
import { showDialog } from '../../shared/ui/dialog';
import { tr } from '../../shared/lang/i18n-lite';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';

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
    'propagated', 'propagated_anim_backward',
    'downstream', 'token_tooltip',
] as const;

/** gen_attribute.html UI 原文；key 与上报/存储一致 */
const GEN_ATTR_OPT_LABELS: Record<(typeof GEN_ATTR_OPT_ORDER)[number], string> = {
    propagated: 'Propagated attribution mode',
    propagated_anim_backward: 'Animation direction/backward',
    layout_linear_arc: 'DAG layout mode/linear_arc',
    layout_step_down: 'DAG layout mode/step-down',
    layout_spiral: 'DAG layout mode/spiral',
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

/** 秒 → `1d 2h 3m 4s`（省略为 0 的单位；全 0 为 `0s`；负数带负号） */
function formatDurationSec(sec: number): string {
    const sign = sec < 0 ? '-' : '';
    let x = Math.abs(Math.floor(sec));
    const days = Math.floor(x / 86400);
    x %= 86400;
    const h = Math.floor(x / 3600);
    x %= 3600;
    const m = Math.floor(x / 60);
    const s = x % 60;
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
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

    const genAttrOpts = data.gen_attr_opt_sec ?? {};
    const genAttrTotalSec = pg['causal_flow.html'] ?? 0;
    const genAttrOptKeys = orderedKeysGt0(GEN_ATTR_OPT_ORDER, genAttrOpts);
    const genAttrOptLines: string[] = genAttrOptKeys.length > 0 && genAttrTotalSec > 0
        ? genAttrOptKeys.map((k) => {
            const v = genAttrOpts[k] ?? 0;
            const pct = Math.round(v / genAttrTotalSec * 100);
            const main = hasBase ? `${formatDurationSec(v)} (${pct}%)` : 'unknown';
            const bv = (sb.gen_attr_opt_sec ?? {})[k] ?? 0;
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
            const wrap = dialog
                .append('div')
                .attr('class', 'dialog-form-container dialog-form-container--fill');
            const headerRow = wrap
                .append('div')
                .style('display', 'flex')
                .style('justify-content', 'flex-end')
                .style('align-items', 'center')
                .style('gap', '6px')
                .style('margin-bottom', '6px');
            const body = wrap.append('div').attr('class', 'dialog-scroll-region');
            headerRow
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
                        await fetchAndRender(body);
                    } catch (e) {
                        alert(`Reset failed: ${e}`);
                    } finally {
                        btn.property('disabled', false).style('opacity', null).text('Persist and reset delta');
                    }
                });
            headerRow
                .append('button')
                .attr('type', 'button')
                .attr('class', 'refresh-btn')
                .attr('title', 'Refresh')
                .text('↻')
                .on('click', async function () {
                    const btn = d3.select(this);
                    btn.property('disabled', true).text('…');
                    await fetchAndRender(body);
                    btn.property('disabled', false).text('↻');
                });
            fetchAndRender(body);
            return { focus: () => {} };
        },
        cancelText: tr('Exit'),
        confirmText: null,
        width: 'clamp(340px, 90vw, 460px)',
    });
}
