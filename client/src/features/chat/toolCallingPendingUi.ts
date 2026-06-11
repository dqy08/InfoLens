import { measureTrailingSuffixLineAnchor } from '../../shared/prediction_attribution/causal_flow/genAttributeDagTextMeasure';

export const MOCK_TOOL_STEP_DELAY_MS = 1000;
export const TOOL_CALLING_PENDING_LABEL = 'Calling tool...';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function abortableDelayMs(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
            } else {
                resolve();
            }
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export type ToolCallingPendingLine = {
    show(): void;
    hide(): void;
};

/**
 * Causal Flow：用测量层 Range 定位，在 SVG zoom 根下渲染占位文案（与节点文字同源字号/变换）。
 */
export function attachToolCallingPendingLine(stackEl: HTMLElement): ToolCallingPendingLine {
    let textEl: SVGTextElement | null = null;

    function svgZoomRoot(): SVGGElement | null {
        return stackEl.querySelector('.gen-attr-dag-svg .gen-attr-dag-zoom-root');
    }

    function measureRoot(): HTMLElement | null {
        return stackEl.querySelector('.gen-attr-dag-measure-layer');
    }

    return {
        show() {
            const measureEl = measureRoot();
            const zoomRoot = svgZoomRoot();
            if (!measureEl || !zoomRoot) return;

            const { x, y } = measureTrailingSuffixLineAnchor(measureEl, TOOL_CALLING_PENDING_LABEL);
            if (!textEl) {
                textEl = document.createElementNS(SVG_NS, 'text');
                textEl.setAttribute('class', 'gen-attr-dag-node-text tool-calling-pending-text');
                textEl.setAttribute('xml:space', 'preserve');
                textEl.setAttribute('text-anchor', 'start');
                textEl.setAttribute('dominant-baseline', 'hanging');
                textEl.setAttribute('pointer-events', 'none');
                zoomRoot.appendChild(textEl);
            }
            textEl.setAttribute('x', String(x));
            textEl.setAttribute('y', String(y));
            textEl.textContent = TOOL_CALLING_PENDING_LABEL;
            textEl.style.display = '';
        },
        hide() {
            if (textEl) textEl.style.display = 'none';
        },
    };
}

/** live 生成：mock tool 固定 1s。▶ 回放：等 response 的 3× token 时钟（见 genAttributeDagPropagationPlaybackPacing）。 */
export async function runMockToolPendingGap(
    signal?: AbortSignal,
    ui?: ToolCallingPendingLine,
): Promise<void> {
    ui?.show();
    try {
        await abortableDelayMs(MOCK_TOOL_STEP_DELAY_MS, signal);
    } finally {
        ui?.hide();
    }
}
