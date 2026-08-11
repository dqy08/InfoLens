import * as d3 from 'd3';
import type { SimpleEventHandler } from '../../shared/core/SimpleEventHandler';
import { GLTR_Mode, GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import { CHAT_SURPRISAL_COLOR_MAP_MAX } from '../../shared/cross/SurprisalColorConfig';
import { buildCompletionDisplayResult } from './buildCompletionDisplayResult';
import type { ChatDisplaySegment } from './chatSegments';

/** 展示用：前块为 output 且末尾无 \\n 时，去掉 input 前导 \\n（块边界已承担该换行，避免双空行）。 */
function inputSegmentTextForDisplay(
    text: string,
    prev: ChatDisplaySegment | undefined
): string {
    if (
        prev?.kind === 'output' &&
        text.startsWith('\n') &&
        !prev.text.endsWith('\n')
    ) {
        return text.slice(1);
    }
    return text;
}

const GLTR_OPTIONS = {
    gltrMode: GLTR_Mode.fract_p,
    enableRenderAnimation: false,
    enableMinimap: false,
    overlayTokenRenderStyle: 'classic' as const,
    surprisalColorMax: CHAT_SURPRISAL_COLOR_MAP_MAX,
};

export class ChatTurnsView {
    private readonly container: d3.Selection<HTMLElement, unknown, null, undefined>;
    private readonly eventHandler: SimpleEventHandler;
    private gltrBoxes: GLTR_Text_Box[] = [];
    private lastSegments: ChatDisplaySegment[] = [];
    /** 最近点击的 output 段索引；-1 表示默认最后一轮 */
    private activeOutputIndex = -1;

    constructor(
        container: HTMLElement,
        eventHandler: SimpleEventHandler
    ) {
        this.container = d3.select(container);
        this.eventHandler = eventHandler;
    }

    clear(): void {
        for (const box of this.gltrBoxes) {
            box.destroy?.();
        }
        this.gltrBoxes = [];
        this.activeOutputIndex = -1;
        this.container.selectAll('*').remove();
    }

    rerender(): void {
        if (this.lastSegments.length > 0) {
            this.render(this.lastSegments);
        }
    }

    private resolvedOutputIndex(): number {
        if (this.activeOutputIndex >= 0 && this.activeOutputIndex < this.gltrBoxes.length) {
            return this.activeOutputIndex;
        }
        return Math.max(0, this.gltrBoxes.length - 1);
    }

    getActiveAnalyzeResult() {
        const box = this.gltrBoxes[this.resolvedOutputIndex()];
        return box?.getCurrentAnalyzeResult() ?? null;
    }

    getPromptPrefixForSidebar(): string {
        const outIdx = this.resolvedOutputIndex();
        let outputCount = 0;
        let legacyPrefix = '';
        for (const seg of this.lastSegments) {
            if (seg.kind === 'output') {
                if (outputCount === outIdx) {
                    return seg.promptUsed ?? legacyPrefix;
                }
                outputCount++;
            }
            legacyPrefix += seg.text;
        }
        return '';
    }

    getFullTextForCopy(): string {
        return this.lastSegments.map((s) => s.text).join('');
    }

    render(segments: ChatDisplaySegment[]): void {
        this.lastSegments = segments;
        const prevActive = this.activeOutputIndex;
        this.clear();
        let outputIndex = 0;
        let prev: ChatDisplaySegment | undefined;
        for (const seg of segments) {
            if (seg.kind === 'input') {
                const block = this.container
                    .append('div')
                    .attr('class', 'chat-segment chat-segment-input');
                block
                    .append('pre')
                    .attr(
                        'class',
                        seg.pending
                            ? 'chat-segment-input-text tool-calling-pending-text'
                            : 'chat-segment-input-text',
                    )
                    .text(inputSegmentTextForDisplay(seg.text, prev));
            } else {
                const block = this.container
                    .append('div')
                    .attr('class', 'chat-segment chat-segment-output');
                const bpe = seg.response.info_radar?.bpe_strings;
                // OpenRouter 等旁路无 token 级数据：纯文本展示，不走 GLTR
                if (!bpe || bpe.length === 0) {
                    block
                        .append('pre')
                        .attr('class', 'chat-segment-output-text')
                        .text(seg.text);
                    if (seg.metaJson !== undefined) {
                        block
                            .append('pre')
                            .attr('class', 'chat-segment-meta-json')
                            .text(JSON.stringify(seg.metaJson, null, 2));
                    }
                } else {
                    const outHost = block.append('div').attr('class', 'chat-segment-output-host');
                    const box = new GLTR_Text_Box(outHost, this.eventHandler);
                    box.updateOptions(GLTR_OPTIONS, true);
                    const display = buildCompletionDisplayResult(
                        seg.text,
                        seg.modelName,
                        bpe
                    );
                    box.update(display);
                    const capturedIndex = outputIndex;
                    block.node()?.addEventListener(
                        'click',
                        () => {
                            this.activeOutputIndex = capturedIndex;
                        },
                        true
                    );
                    if (capturedIndex === prevActive) {
                        this.activeOutputIndex = capturedIndex;
                    }
                    this.gltrBoxes.push(box);
                    outputIndex++;
                }
            }
            prev = seg;
        }
    }

}
