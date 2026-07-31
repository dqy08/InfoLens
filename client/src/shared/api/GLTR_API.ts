/*
Attn API and Types
 */

import * as d3 from "d3";
import { resolveApiBase, apiUrl } from "./resolveApiBase";
import { resolveDemoFileUrl } from "./apiConfig";
import {cleanSpecials} from "../core/Util";
import * as semanticResultCache from "../cross/semanticResultCache";
import { getSemanticMatchThreshold } from "../cross/semanticThresholdManager";
import {AnalyzeResponse, AnalyzeResult, TokenWithOffset} from "./generatedSchemas";

/** 前端合并原因；未合并则不含此字段 */
export type BpeMergeReason = 'overlap' | 'digit';

export type FrontendToken = TokenWithOffset & {
    bpe_merged?: BpeMergeReason;
    /** 合并前的子片段 raw 列表（顺序与 tokenizer 步一致）；仅 `bpe_merged` 存在时有意义，供 tooltip 展示 */
    bpe_merge_parts?: string[];
};
export interface FrontendAnalyzeResult extends AnalyzeResult {
    bpe_strings: FrontendToken[];
    originalTokens: FrontendToken[];
    bpeBpeMergedTokens: FrontendToken[];
    originalText: string; // 前端注入的原始文本（来自 request.text）
}

// AnalyzedText 已废弃，请使用 FrontendAnalyzeResult
export type AnalyzedText = FrontendAnalyzeResult; // @deprecated 使用 FrontendAnalyzeResult

// 类型别名：AnalysisData 用于 demo 存储场景（保存后的数据），AnalyzeResponse 用于 API 分析场景（保存前的数据）
export type AnalysisData = AnalyzeResponse;
export type { AnalyzeResponse, TokenWithOffset };

/** 语义分析响应可能包含 __fromCache，用于判断是否来自缓存 */
export function isSemanticFromCache(res: unknown): boolean {
    return !!(res as { __fromCache?: boolean } | null | undefined)?.__fromCache;
}

/** 语义分析 options：onProgress 传入时启用 stream，否则普通 JSON */
export interface AnalyzeSemanticOptions {
    onProgress?: (step: number, totalSteps: number, stage: string, percentage?: number) => void;
    /** 整段模式需要展示时传 true；不传则不请求，默认关 */
    debug_info?: boolean;
    signal?: AbortSignal;
}

export type SemanticDebugInfo = {
    abbrev?: string;
    topk_tokens?: string[];
    topk_probs?: number[];
};

/** 各 token 的归因 score；API 字段名 `token_attention` 为历史遗留，非 attention 权重 */
export type SemanticTokenScore = {
    offset: [number, number];
    raw: string;
    score: number;
};

type SemanticApiBase = {
    success: boolean;
    model?: string;
    debug_info?: SemanticDebugInfo;
    message?: string;
    /** 客户端缓存命中标记，非 API 字段 */
    __fromCache?: boolean;
};

/** /api/analyze-semantic-relevance */
export type SemanticRelevanceResult = SemanticApiBase & {
    full_match_degree: number;
};

/** /api/analyze-semantic-keywords */
export type SemanticKeywordsResult = SemanticApiBase & {
    token_attention: SemanticTokenScore[];
};

/** hybrid 组合：相关度门控 + 关键词归因（未过阈值时 token_attention 为空数组） */
export type SemanticResult = SemanticApiBase & {
    full_match_degree: number;
    token_attention: SemanticTokenScore[];
};

export class TextAnalysisAPI {
    private adminToken: string | null = null;

    constructor(private baseURL: string | null = null) {
        if (this.baseURL == null) {
            this.baseURL = resolveApiBase();
        }
    }

    /** 本实例 API 根（构造时或 resolveApiBase）；路径以 `/api/...` 传入 */
    private url(path: string): string {
        return apiUrl(path, this.baseURL ?? '');
    }

    /**
     * 设置admin token
     */
    public setAdminToken(token: string | null): void {
        this.adminToken = token;
    }

    /**
     * 获取请求头（如果有admin token，自动添加到请求头）
     */
    private getHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-type": "application/json; charset=UTF-8",
            ...additionalHeaders
        };
        
        // 如果有admin token，自动添加
        if (this.adminToken) {
            headers['X-Admin-Token'] = this.adminToken;
        }
        
        return headers;
    }


    public list_demos(path?: string): Promise<{ path: string, items: Array<{type: 'folder'|'file', name: string, path: string}> }> {
        const url = this.url('/api/list_demos') + (path ? `?path=${encodeURIComponent(path)}` : '');
        return d3.json(url, { headers: this.getHeaders() });
    }

    /** 加载服务端 demo JSON（管理员带 token 时可读 --dir 下不公开文件） */
    public load_demo_file(path: string): Promise<AnalysisData> {
        return d3.json(resolveDemoFileUrl(path), { headers: this.getHeaders() });
    }

    public save_demo(name: string, data: AnalyzeResponse, path: string = '/', overwrite: boolean = false): Promise<{ success: boolean, exists?: boolean, message?: string, file?: string }> {
        return d3.json(this.url('/api/save_demo'), {
            method: "POST",
            body: JSON.stringify({ name, data, path, overwrite }),
            headers: this.getHeaders()
        });
    }

    public delete_demo(file: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/delete_demo'), {
            method: "POST",
            body: JSON.stringify({ file }),
            headers: this.getHeaders()
        });
    }

    public move_demo(file: string, targetPath: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/move_demo'), {
            method: "POST",
            body: JSON.stringify({ file, target_path: targetPath }),
            headers: this.getHeaders()
        });
    }

    public move_folder(path: string, targetPath: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/move_demo'), {
            method: "POST",
            body: JSON.stringify({ path, target_path: targetPath }),
            headers: this.getHeaders()
        });
    }

    public rename_demo(file: string, newName: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/rename_demo'), {
            method: "POST",
            body: JSON.stringify({ file, new_name: newName }),
            headers: this.getHeaders()
        });
    }

    public rename_folder(path: string, newName: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/rename_folder'), {
            method: "POST",
            body: JSON.stringify({ path, new_name: newName }),
            headers: this.getHeaders()
        });
    }

    public delete_folder(path: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/delete_folder'), {
            method: "POST",
            body: JSON.stringify({ path }),
            headers: this.getHeaders()
        });
    }

    public list_all_folders(): Promise<{ folders: string[] }> {
        return d3.json(this.url('/api/list_all_folders'), { headers: this.getHeaders() });
    }

    public create_folder(parentPath: string, folderName: string): Promise<{ success: boolean, message?: string }> {
        return d3.json(this.url('/api/create_folder'), {
            method: "POST",
            body: JSON.stringify({ parent_path: parentPath, folder_name: folderName }),
            headers: this.getHeaders()
        });
    }

    /**
     * 构建分析请求的 payload
     */
    private buildAnalyzePayload(
        model: string, 
        text: string, 
        bitmask: number[] = null,
        stream: boolean = false
    ): any {
        const payload: any = {
            model, 
            text: cleanSpecials(text)
        };
        if (bitmask) {
            payload['bitmask'] = bitmask;
        }
        if (stream) {
            payload['stream'] = true;
        }
        return payload;
    }

    public analyze(
        model: string, 
        text: string, 
        bitmask: number[] = null,
        stream: boolean = false,
        onProgress?: (step: number, totalSteps: number, stage: string, percentage?: number) => void
    ): Promise<AnalyzeResponse> {
        // 如果启用流式响应，使用SSE方式
        if (stream) {
            return this.analyzeWithProgress(model, text, onProgress);
        }

        // 否则使用传统的JSON响应
        const payload = this.buildAnalyzePayload(model, text, bitmask, stream);
        return d3.json(this.url('/api/analyze'), {
            method: "POST",
            body: JSON.stringify(payload),
            headers: {
                "Content-type": "application/json; charset=UTF-8"
            }
        }).then((response: any) => {
            // 检查统一的错误格式
            if (response && response.success === false) {
                throw new Error(response.message || 'Analysis failed');
            }
            return response as AnalyzeResponse;
        });
    }

    /**
     * 从 URL 提取文本内容
     * 
     * @param url 要提取文本的 URL
     * @returns Promise<{success: boolean, text?: string, url?: string, char_count?: number, message?: string}>
     */
    public fetchUrlText(url: string): Promise<{success: boolean, text?: string, url?: string, char_count?: number, message?: string}> {
        return d3.json(this.url('/api/fetch_url'), {
            method: "POST",
            body: JSON.stringify({ url }),
            headers: {
                "Content-type": "application/json; charset=UTF-8"
            }
        }).then((response: any) => {
            // 检查统一的错误格式
            if (response && response.success === false) {
                throw new Error(response.message || 'URL text extraction failed');
            }
            return response;
        });
    }

    public getVisitStats(): Promise<{
        success: boolean,
        totals: { page_loads: number, active_visits: number },
        os: Record<string, number>,
        origin_visits?: Record<string, number>,
        page_sec: Record<string, number>,
        api: Record<string, number>,
        gen_attr_opt_sec?: Record<string, number>,
        saved_at: string | null,
        process_start_at?: string | null,
        startup_base?: {
            page_loads?: number,
            active_visits?: number,
            page_sec?: Record<string, number>,
            api?: Record<string, number>,
            os?: Record<string, number>,
            origin_visits?: Record<string, number>,
            gen_attr_opt_sec?: Record<string, number>,
        },
        reset_base?: {
            page_loads?: number,
            active_visits?: number,
            page_sec?: Record<string, number>,
            api?: Record<string, number>,
            os?: Record<string, number>,
            origin_visits?: Record<string, number>,
            gen_attr_opt_sec?: Record<string, number>,
        },
        reset_at?: string | null,
        online_now?: number,
        online_window_sec?: number,
    }> {
        return d3.json(this.url('/api/visit_stats'), {
            headers: this.getHeaders()
        });
    }

    public resetVisitStats(): Promise<{ success: boolean, error?: string }> {
        return d3.json(this.url('/api/visit_stats/reset'), {
            method: 'POST',
            headers: this.getHeaders(),
        });
    }

    /** bins[].hour 格式见 visitStatsContract.ts STATS_UTC_HOUR_FMT */
    public getVisitStatsActiveVisitsTimeline(): Promise<{
        success: boolean,
        bins?: { hour: string, active_visits: number, active_sec: number }[],
        error?: string,
    }> {
        return d3.json(this.url('/api/visit_stats/active_visits_timeline'), {
            headers: this.getHeaders(),
        });
    }

    /**
     * 获取可用模型列表
     */
    public getAvailableModels(): Promise<{ success: boolean, models: string[] }> {
        return d3.json(this.url('/api/available_models'));
    }

    /**
     * 获取当前模型
     */
    public getCurrentModel(): Promise<{ 
        success: boolean, 
        model: string, 
        loading: boolean,
        device_type: 'cpu' | 'cuda' | 'mps',
        use_int8: boolean,
        use_bfloat16: boolean
    }> {
        return d3.json(this.url('/api/current_model'));
    }

    /**
     * 切换模型（需要管理员权限）
     */
    public switchModel(
        model: string, 
        use_int8?: boolean, 
        use_bfloat16?: boolean
    ): Promise<{ success: boolean, message?: string, model?: string }> {
        return d3.json(this.url('/api/switch_model'), {
            method: "POST",
            body: JSON.stringify({ 
                model,
                use_int8: use_int8 || false,
                use_bfloat16: use_bfloat16 || false
            }),
            headers: this.getHeaders()
        });
    }

    /**
     * Semantic analysis：先相关度门控，再关键词归因（原生两接口组合）。
     * onProgress 传入时 stream=true，否则普通 JSON；返回格式与旧 hybrid 一致。
     */
    public async analyzeSemantic(
        query: string,
        text: string,
        options?: AnalyzeSemanticOptions
    ): Promise<SemanticResult> {
        const { onProgress, debug_info: wantDebugInfo, signal } = options ?? {};
        const r1 = await this.analyzeSemanticRelevance(query, text, { onProgress, debug_info: wantDebugInfo, signal });
        if (!r1.success) {
            return { success: false, message: r1.message, full_match_degree: 0, token_attention: [] };
        }
        if (typeof r1.full_match_degree !== 'number') {
            throw new Error('Semantic relevance response missing full_match_degree');
        }
        if (r1.full_match_degree < getSemanticMatchThreshold()) {
            return { ...r1, token_attention: [] };
        }
        const r2 = await this.analyzeSemanticKeywords(query, text, { onProgress, debug_info: wantDebugInfo, signal });
        if (!r2.success) {
            return { success: false, message: r2.message, full_match_degree: r1.full_match_degree, token_attention: [] };
        }
        return {
            ...r2,
            full_match_degree: r1.full_match_degree,
            __fromCache: isSemanticFromCache(r1) && isSemanticFromCache(r2),
        };
    }

    /** 全文相关度：/api/analyze-semantic-relevance */
    public async analyzeSemanticRelevance(
        query: string,
        text: string,
        options?: AnalyzeSemanticOptions
    ): Promise<SemanticRelevanceResult> {
        return this.fetchSemanticEndpoint(
            '/api/analyze-semantic-relevance',
            'relevance',
            query,
            text,
            options,
            (cached): cached is SemanticRelevanceResult => typeof cached.full_match_degree === 'number',
        );
    }

    /** 关键词归因：/api/analyze-semantic-keywords */
    public async analyzeSemanticKeywords(
        query: string,
        text: string,
        options?: AnalyzeSemanticOptions
    ): Promise<SemanticKeywordsResult> {
        return this.fetchSemanticEndpoint(
            '/api/analyze-semantic-keywords',
            'keywords',
            query,
            text,
            options,
            (cached): cached is SemanticKeywordsResult => Array.isArray(cached.token_attention),
        );
    }

    private async fetchSemanticEndpoint<T extends SemanticApiBase>(
        path: string,
        cacheKey: string,
        query: string,
        text: string,
        options: AnalyzeSemanticOptions | undefined,
        cacheOk: (cached: semanticResultCache.SemanticCacheResult) => cached is T,
    ): Promise<T> {
        const { onProgress, debug_info: wantDebugInfo, signal } = options ?? {};
        const cached = semanticResultCache.get(text, query, cacheKey);
        if (cached && cacheOk(cached)) {
            return { ...cached, __fromCache: true };
        }
        const stream = !!onProgress;
        const payload: Record<string, unknown> = { query, text, stream };
        if (wantDebugInfo) payload.debug_info = true;
        const res = stream
            ? await this.fetchSSEStream<T>(path, payload, onProgress, 'Semantic analysis failed', signal)
            : await this.fetchSemanticJson<T>(path, payload, signal);
        if (res?.success) semanticResultCache.set(text, query, res, cacheKey);
        return res;
    }

    private async fetchSemanticJson<T>(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        const res = await fetch(this.url(path), {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload),
            signal
        });
        const data = await res.json();
        if (data && data.success === false) {
            throw new Error(data.message || 'Semantic analysis failed');
        }
        return data;
    }

    /**
     * 使用SSE流式分析文本，支持进度回调（内部方法）
     */
    private analyzeWithProgress(
        model: string,
        text: string,
        onProgress?: (step: number, totalSteps: number, stage: string, percentage?: number) => void
    ): Promise<AnalyzeResponse> {
        return this.fetchSSEStream(
            '/api/analyze',
            this.buildAnalyzePayload(model, text, null, true),
            onProgress,
            'Analysis failed'
        );
    }

    /**
     * 通用 SSE 流式请求：fetch + ReadableStream 解析（analyze 与 analyzeSemantic 复用）
     * 支持 signal 中止；中止后丢弃后续到达的数据
     */
    private fetchSSEStream<T>(
        path: string,
        payload: any,
        onProgress: (step: number, totalSteps: number, stage: string, percentage?: number) => void | undefined,
        errorMessage: string,
        signal?: AbortSignal
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const safeResolve = (v: T) => { if (!settled && !signal?.aborted) { settled = true; resolve(v); } };
            const safeReject = (e: unknown) => { if (!settled) { settled = true; reject(e); } };

            fetch(this.url(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(payload),
                signal
            }).then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const reader = response.body!.getReader();
                signal?.addEventListener('abort', () => reader.cancel(), { once: true });

                const decoder = new TextDecoder();
                let buffer = '';

                const processLine = (line: string) => {
                    if (settled || signal?.aborted) return;
                    this.processSSEMessage(line, onProgress, safeResolve as (v: any) => void, safeReject, errorMessage);
                };

                const readChunk = (): Promise<void> => {
                    return reader.read().then(({ done, value }) => {
                        if (settled || signal?.aborted) return;
                        if (done) {
                            if (buffer.trim()) processLine(buffer);
                            return;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (line.startsWith('data: ')) processLine(line.slice(6));
                        }
                        return readChunk();
                    });
                };
                return readChunk();
            }).catch((e) => {
                if (!settled) { settled = true; reject(e); }
            });
        });
    }

    /**
     * 处理 SSE 消息（progress / result / error，analyze 与 analyzeSemantic 复用）
     */
    private processSSEMessage(
        data: string,
        onProgress: (step: number, totalSteps: number, stage: string, percentage?: number) => void | undefined,
        resolve: (value: any) => void,
        reject: (reason?: any) => void,
        errorMessage: string = 'Analysis failed'
    ): void {
        try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'progress') {
                if (onProgress) {
                    onProgress(parsed.step, parsed.total_steps, parsed.stage, parsed.percentage);
                }
            } else if (parsed.type === 'result') {
                const resultData = parsed.data;
                if (resultData && resultData.success === false) {
                    reject(new Error(resultData.message || errorMessage));
                } else {
                    resolve(resultData);
                }
            } else if (parsed.type === 'error') {
                reject(new Error(parsed.message || errorMessage));
            }
        } catch (e) {
            const msg = e instanceof SyntaxError
                ? `Failed to parse SSE data: ${e.message} (backend may have returned invalid JSON, e.g. NaN)`
                : `Failed to process SSE message: ${e instanceof Error ? e.message : String(e)}`;
            reject(new Error(msg));
        }
    }


}

