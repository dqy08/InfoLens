/**
 * 远程 relevance：OpenRouter Chat → full_match_degree。
 * 由 /facade-relevance-switch 控制；默认开（缺 key = 开），显式关则回 HF/Home。
 * 模型 Hy3、clearly_zero 关，写死；与 scripts/eval_semantic_relevance_remote.py 基线对齐。
 * max_tokens=8；从开头解析：可选空白 + 非负整数字前缀，否则视为本次分析失败。
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const RELEVANCE_MODEL = 'tencent/hy3';
const RELEVANCE_MAX_TOKENS = 8;

export const REMOTE_RELEVANCE_KEY = 'remote_relevance';
export const RELEVANCE_PATH = '/api/analyze-semantic-relevance';

export function buildRelevanceUserContent(query, text) {
  return (
    `How many words in the text below are related to the query topic (${query})? Text:\n\n` +
    text +
    '\n\nReply with a single non-negative integer only, nothing else.'
  );
}

/**
 * 从开头匹配：可选空白 + 一段连续数字；不扫后面乱码。SYNC: eval parse_count
 * @returns {number|null}
 */
function parseCount(content) {
  if (!content || typeof content !== 'string') return null;
  const m = content.match(/^\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const ERROR_DETAIL_MAX = 500;

/**
 * 远程 relevance 失败粗分（message 给用户；error_detail 仅日志/反馈，不含 query/text）：
 * - network：Worker↔OpenRouter 传输层（超时、断连、fetch 失败）
 * - inference：推理 API 暂时/服务端错误（408/429/5xx、响应体内 error）
 * - internal：我方未预期（缺密钥、输出不可解析、4xx 鉴权/请求、未知）
 *
 * 扩展本地错误（正文变化、无正文等）不经此函数，见 content.js showFindError。
 * @returns {{ kind: 'network' | 'inference' | 'internal', message: string, error_detail: string }}
 */
function publicRelevanceError(err) {
  const raw = err && err.message != null ? String(err.message) : String(err);
  const error_detail =
    raw.length <= ERROR_DETAIL_MAX ? raw : raw.slice(0, ERROR_DETAIL_MAX - 1) + '…';

  if (
    /^network:/i.test(raw) ||
    (typeof TypeError !== 'undefined' && err instanceof TypeError) ||
    /network|fetch failed|timed out|timeout|ECONNRESET|connection/i.test(raw)
  ) {
    return { kind: 'network', message: 'Network error', error_detail };
  }

  const http =
    raw.match(/OpenRouter HTTP (\d+)/) ||
    raw.match(/OpenRouter non-JSON response: HTTP (\d+)/);
  if (http) {
    const code = parseInt(http[1], 10);
    if (code === 408 || code === 429 || code >= 500) {
      return {
        kind: 'inference',
        message: `Inference API temporarily unavailable (${code})`,
        error_detail,
      };
    }
    // 4xx（含 401/403/402/404/400）：配置或请求侧，归我方未预期
    return {
      kind: 'internal',
      message: `Unexpected analysis error (${code})`,
      error_detail,
    };
  }

  // HTTP 200 但 body 带 error：视为推理侧
  if (/^OpenRouter error:/i.test(raw)) {
    return {
      kind: 'inference',
      message: 'Inference API temporarily unavailable',
      error_detail,
    };
  }

  return {
    kind: 'internal',
    message: 'Unexpected analysis error',
    error_detail,
  };
}

/**
 * @returns {Promise<{ full_match_degree: number, model: string, input_token_count: number }>}
 */
export async function chatRelevance(env, query, text) {
  const token = (env.OPENROUTER_API_KEY || '').trim();
  if (!token) {
    throw new Error('OPENROUTER_API_KEY secret is not set');
  }

  let resp;
  try {
    resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://info-lens.app',
        'X-Title': 'infolens-relevance',
      },
      body: JSON.stringify({
        model: RELEVANCE_MODEL,
        messages: [{ role: 'user', content: buildRelevanceUserContent(query, text) }],
        temperature: 0,
        max_tokens: RELEVANCE_MAX_TOKENS,
        stream: false,
        reasoning: { effort: 'none' },
      }),
    });
  } catch (e) {
    const m = e && e.message != null ? String(e.message) : String(e);
    throw new Error(`network: ${m}`);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`OpenRouter non-JSON response: HTTP ${resp.status}`);
  }
  if (resp.status >= 400) {
    const err = data && (data.error || data);
    throw new Error(`OpenRouter HTTP ${resp.status}: ${JSON.stringify(err)}`);
  }
  if (data && data.error) {
    const errStr = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw new Error(`OpenRouter error: ${errStr}`);
  }

  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const content = msg.content;
  const count = parseCount(content);
  if (count === null) {
    throw new Error(`unparseable model output: content=${JSON.stringify(content)}`);
  }

  const usage = data.usage || {};
  const inputTokenCount =
    typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
        : 0;

  return {
    full_match_degree: count > 0 ? 1.0 : 0.0,
    model: data.model || RELEVANCE_MODEL,
    input_token_count: inputTokenCount,
  };
}

/**
 * 处理 POST /api/analyze-semantic-relevance（单条 text；texts/stream 仅本地后端支持）。
 * @param {(req: Request, body: object, status?: number) => Response} json
 */
export async function handleRemoteRelevance(request, env, json) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method_not_allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { success: false, message: 'invalid json' }, 400);
  }

  if (body && body.texts != null) {
    return json(request, { success: false, message: 'texts is not supported on remote relevance' }, 400);
  }
  if (body && body.stream) {
    return json(request, { success: false, message: 'stream is not supported on remote relevance' }, 400);
  }

  const query = (body && body.query) || '';
  if (!query) {
    return json(request, { success: false, message: 'Missing query' }, 400);
  }

  const text = (body && body.text) || '';
  if (!text) {
    return json(request, { success: false, message: 'Missing text' }, 400);
  }

  try {
    const r = await chatRelevance(env, query, text);
    return json(request, {
      success: true,
      model: r.model,
      full_match_degree: r.full_match_degree,
      input_token_count: r.input_token_count,
    });
  } catch (err) {
    const pub = publicRelevanceError(err);
    console.error('remote relevance failed', pub.kind, pub.error_detail);
    return json(
      request,
      { success: false, message: pub.message, error_detail: pub.error_detail },
      503,
    );
  }
}
