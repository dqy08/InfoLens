/**
 * 远程 relevance：OpenRouter Chat → full_match_degree。
 * 始终边缘短路，无 HF/Home 回退。
 * 模型 Hy3、clearly_zero 关，写死；与 scripts/eval_semantic_relevance_remote.py 基线对齐
 * （Task/Query 各一行；Text: 上下空行夹正文；文尾 Task Reminder:+Query:）。
 * max_tokens=8；从开头解析：可选空白 + 非负整数字前缀，否则视为本次分析失败。
 */
import { logRemoteFailure, publicRemoteError } from './remote_log.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const RELEVANCE_MODEL = 'tencent/hy3';
const RELEVANCE_MAX_TOKENS = 8;

export const RELEVANCE_PATH = '/api/analyze-semantic-relevance';

export function buildRelevanceUserContent(query, text) {
  const task =
    'How many words in the text are related to the query topic? ' +
    'Reply with a single non-negative integer only, nothing else.';
  const queryLine = `Query: ${query}`;
  const head = `Task: ${task}\n${queryLine}`;
  const reminder = `Task Reminder: ${task}\n${queryLine}`;
  return `${head}\nText:\n\n${text}\n\n${reminder}`;
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
        provider: { sort: 'latency' },
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
    const pub = publicRemoteError(err);
    await logRemoteFailure('remote_relevance_failed', err, pub, env, request);
    return json(
      request,
      { success: false, message: pub.message, error_detail: pub.error_detail },
      503,
    );
  }
}
