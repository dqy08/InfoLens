/**
 * 远程 keywords v2：OpenRouter Chat（虚拟提交工具）→ 无重叠 token_attention（可直接上色）。
 * 路径 /api/v2/analyze-semantic-keywords；只走边缘远程，无本地/HF 回退。
 * 双轨：旧扩展仍用 /api/analyze-semantic-keywords（梯度归因）；本模块不接管旧路径。
 * 提示词 / tool / 解析 SYNC: scripts/eval_semantic_keywords_remote.py
 * - 强制 tool_choice → submit_keywords；只读 arguments，不执行副作用
 * - arguments 须为合法 JSON；非法则失败（不做 fence）
 * - 仅当 length 截断（native_finish_reason/finish_reason=length）时，从残缺 JSON 捞已写完的条目
 * - score 整数 1–5；正文忽略大小写找齐全部出现；原文找不到则跳过
 * - 字重叠取 max，不累加；模型分先归一化到 (0,1]
 * - 渲染 Workarounds（uniquifyHighScores / REPEAT_DIM）：只服务上色观感，不代表模型能力；
 *   评测模型抽取能力请用 scripts/eval_semantic_keywords_remote.py（不跑定位/压分）
 * - 不返回 input_token_count
 */
import { logRemoteFailure, publicRemoteError } from './remote_log.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const KEYWORDS_MODEL = 'tencent/hy3';
const KEYWORDS_MAX_TOKENS = 256;
const TOOL_NAME = 'submit_keywords';

export const KEYWORDS_V2_PATH = '/api/v2/analyze-semantic-keywords';

/** SYNC: scripts/eval_semantic_keywords_remote.py → KEYWORDS_TASK / build_keywords_user_content */
const KEYWORDS_TASK =
  'Extract all keywords related to the query topic. ' +
  'A keyword can be a word or short phrase. ' +
  'Make sure to only extract keywords that appear in the text. ' +
  'Order them from most important to least important. ' +
  `Submit with ${TOOL_NAME}.`;

/** SYNC: scripts/eval_semantic_keywords_remote.py → SUBMIT_KEYWORDS_TOOL */
const SUBMIT_KEYWORDS_TOOL = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Submit extracted keywords with scores.',
    parameters: {
      type: 'object',
      required: ['keywords'],
      properties: {
        keywords: {
          type: 'array',
          items: {
            type: 'object',
            required: ['keyword', 'score'],
            properties: {
              keyword: { type: 'string' },
              score: {
                type: 'integer',
                description: '1 (slightly related) to 5 (strongly related).',
              },
            },
          },
        },
      },
    },
  },
};

/** SYNC: scripts/eval_semantic_keywords_remote.py → build_keywords_user_content（三明治） */
export function buildKeywordsUserContent(query, text) {
  const queryLine = `Query: ${query}`;
  const head = `Task: ${KEYWORDS_TASK}\n${queryLine}`;
  const reminder = `Task Reminder: ${KEYWORDS_TASK}\n${queryLine}`;
  return `${head}\nText:\n\n${text}\n\n${reminder}`;
}

/**
 * SYNC: scripts/eval_semantic_keywords_remote.py → parse_submit_keywords_arguments
 * 严格 JSON.parse；非法或结构不对 → null
 * @returns {Array<[string, number]>|null}
 */
export function parseSubmitKeywordsArguments(argumentsStr) {
  if (!argumentsStr || typeof argumentsStr !== 'string') return null;
  let data;
  try {
    data = JSON.parse(argumentsStr);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const items = data.keywords;
  if (!Array.isArray(items)) return null;
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const x of items) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const kw = x.keyword;
    const score = x.score;
    if (typeof kw !== 'string' || !kw.trim()) continue;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    let s = Math.round(score);
    s = Math.max(1, Math.min(5, s));
    out.push([kw.trim(), s]);
  }
  // 空数组 = 合法零词；非空却 0 条有效 = 契约外，当解析失败
  if (items.length > 0 && out.length === 0) return null;
  return out;
}

/** OpenRouter 常把 finish_reason 归一成 tool_calls；超长截断看 native_finish_reason=length */
export function isKeywordsLengthStop(choice) {
  if (!choice || typeof choice !== 'object') return false;
  return choice.finish_reason === 'length' || choice.native_finish_reason === 'length';
}

/**
 * SYNC: scripts/eval_semantic_keywords_remote.py → salvage_partial_submit_keywords_arguments
 * 从残缺 arguments 捞已写完的 {keyword,score}；一个都没有 → null
 * @returns {Array<[string, number]>|null}
 */
export function salvagePartialKeywordsArguments(argumentsStr) {
  if (!argumentsStr || typeof argumentsStr !== 'string') return null;
  /** @type {Array<{ i: number, kw: string, score: number }>} */
  const found = [];
  const push = (i, kwRaw, scoreRaw) => {
    let kw;
    try {
      kw = JSON.parse(`"${kwRaw}"`);
    } catch {
      return;
    }
    if (typeof kw !== 'string' || !kw.trim()) return;
    const score = Number(scoreRaw);
    if (!Number.isFinite(score)) return;
    let s = Math.round(score);
    s = Math.max(1, Math.min(5, s));
    found.push({ i, kw: kw.trim(), score: s });
  };
  const reKwScore =
    /\{\s*"keyword"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"score"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/g;
  const reScoreKw =
    /\{\s*"score"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"keyword"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g;
  let m;
  while ((m = reKwScore.exec(argumentsStr))) push(m.index, m[1], m[2]);
  while ((m = reScoreKw.exec(argumentsStr))) push(m.index, m[2], m[1]);
  if (!found.length) return null;
  found.sort((a, b) => a.i - b.i);
  return found.map((x) => /** @type {[string, number]} */ ([x.kw, x.score]));
}

/**
 * 渲染 Workaround（先于定位）：列表中 5/4/3/2 各最多一个，1 不限。
 * 按返回顺序先到先得；撞车则逐级 -1，直到空档或落到 1。
 * 仅调上色层次，不改模型输出；评测抽取能力见 eval_semantic_keywords_remote.py。
 * @param {Array<[string, number]>} scored
 * @returns {Array<[string, number]>}
 */
function uniquifyHighScores(scored) {
  /** @type {Set<number>} */
  const taken = new Set();
  return scored.map(([kw, score]) => {
    let s = score;
    while (s >= 2 && taken.has(s)) s -= 1;
    if (s >= 2) taken.add(s);
    return /** @type {[string, number]} */ ([kw, s]);
  });
}

/**
 * 忽略大小写，按 code point 找齐 keyword 全部出现。
 * @returns {Array<[number, number]>}
 */
function findAllCaseInsensitive(textCps, keyword) {
  const kwCps = Array.from(keyword);
  const m = kwCps.length;
  const n = textCps.length;
  if (m === 0 || m > n) return [];
  const kwLower = keyword.toLowerCase();
  /** @type {Array<[number, number]>} */
  const hits = [];
  for (let i = 0; i <= n - m; i++) {
    const slice = textCps.slice(i, i + m).join('');
    if (slice.toLowerCase() === kwLower) hits.push([i, i + m]);
  }
  return hits;
}

/**
 * 全出现打分 + 字级 max + 收成无重叠 run（线上渲染路径）。
 *
 * 顺序：① uniquifyHighScores（列表档位）→ ② 定位；复现再人工压低
 * （模型只抽词不标位置，重复命中若全用高分会过亮）。
 * uniquify / REPEAT_DIM 是渲染观感 Workaround，不是模型能力指标；
 * 评测只比抽取列表，见 scripts/eval_semantic_keywords_remote.py。
 *
 * @param {Array<[string, number]>} scored
 * @returns {Array<{ offset: [number, number], raw: string, score: number }>}
 */
export function keywordsToTokenAttention(text, scored) {
  const textCps = Array.from(text);
  const n = textCps.length;
  const best = new Float64Array(n);
  /** 模型分 1–5 → (0.2…1.0] */
  const SCORE_NORMALIZE = 5;
  /** 渲染 Workaround：复现亮度相对首现再压低的倍数（非评测项） */
  const REPEAT_DIM_FACTOR = 5;
  const adjusted = uniquifyHighScores(scored);
  for (const [kw, scoreInt] of adjusted) {
    const normalized = scoreInt / SCORE_NORMALIZE;
    const hits = findAllCaseInsensitive(textCps, kw);
    for (let hi = 0; hi < hits.length; hi++) {
      const mapped = hi === 0 ? normalized : normalized / REPEAT_DIM_FACTOR;
      const [s, e] = hits[hi];
      for (let i = s; i < e; i++) {
        if (mapped > best[i]) best[i] = mapped;
      }
    }
  }
  /** @type {Array<{ offset: [number, number], raw: string, score: number }>} */
  const tokenAttention = [];
  let i = 0;
  while (i < n) {
    const sc = best[i];
    if (!(sc > 0)) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && best[i] === sc) i++;
    tokenAttention.push({
      offset: [start, i],
      raw: textCps.slice(start, i).join(''),
      score: sc,
    });
  }
  return tokenAttention;
}

/**
 * @returns {Promise<{ model: string, token_attention: Array<{ offset: [number, number], raw: string, score: number }> }>}
 */
export async function chatKeywordsV2(env, query, text) {
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
        'X-Title': 'infolens-keywords-v2',
      },
      body: JSON.stringify({
        model: KEYWORDS_MODEL,
        messages: [{ role: 'user', content: buildKeywordsUserContent(query, text) }],
        tools: [SUBMIT_KEYWORDS_TOOL],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
        temperature: 0,
        max_tokens: KEYWORDS_MAX_TOKENS,
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
  const toolCalls = msg.tool_calls || [];
  if (!toolCalls.length) {
    throw new Error(
      `missing tool_calls: content=${JSON.stringify(msg.content)} finish_reason=${JSON.stringify(choice.finish_reason)}`,
    );
  }
  const rawArgs = ((toolCalls[0].function || {}).arguments) || '';
  let scored = parseSubmitKeywordsArguments(rawArgs);
  if (scored === null && isKeywordsLengthStop(choice)) {
    scored = salvagePartialKeywordsArguments(rawArgs);
  }
  if (scored === null) {
    throw new Error(`unparseable tool arguments: ${JSON.stringify(rawArgs)}`);
  }

  return {
    model: data.model || KEYWORDS_MODEL,
    token_attention: keywordsToTokenAttention(text, scored),
  };
}

/**
 * @param {(req: Request, body: object, status?: number) => Response} json
 */
export async function handleRemoteKeywordsV2(request, env, json) {
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
    return json(request, { success: false, message: 'texts is not supported on keywords v2' }, 400);
  }
  if (body && body.stream) {
    return json(request, { success: false, message: 'stream is not supported on keywords v2' }, 400);
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
    const r = await chatKeywordsV2(env, query, text);
    return json(request, {
      success: true,
      model: r.model,
      token_attention: r.token_attention,
    });
  } catch (err) {
    const pub = publicRemoteError(err);
    logRemoteFailure('remote_keywords_v2_failed', err, pub);
    return json(
      request,
      { success: false, message: pub.message, error_detail: pub.error_detail },
      503,
    );
  }
}
