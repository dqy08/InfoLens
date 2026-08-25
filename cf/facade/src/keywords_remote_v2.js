/**
 * 远程 keywords v2：OpenRouter Chat（口头逐行 [keyword]<score>）→ 无重叠 token_attention。
 * 路径 /api/v2/analyze-semantic-keywords；只走边缘远程，无本地/HF 回退。
 * 双轨：旧扩展仍用 /api/analyze-semantic-keywords（梯度归因）；本模块不接管旧路径。
 * 提示词 / 解析 SYNC: scripts/eval_semantic_keywords_remote.py（默认口头；--tool 仅评测对照）
 * - 口头：Task 与 Output Format 解耦；头尾同序 Task(Reminder) → Query → Output Format
 *   （跟相关度同一序。Hy3 对这段顺序敏感：相关度实测 Query 在最后会抬错检）
 * - 回复逐行 [keyword]<score>，score 整数 1–5；空字符串 = 合法零词；无 content 报错
 * - 空行忽略；任一非空行对不上格式 → 报错（不跳过）
 * - 正文忽略大小写找齐全部出现；原文找不到则跳过
 * - 字重叠取 max，不累加；模型分先归一化到 (0,1]
 * - 渲染 Workarounds（uniquifyHighScores / REPEAT_DIM）：只服务上色观感，不代表模型能力；
 *   评测模型抽取能力请用 scripts/eval_semantic_keywords_remote.py（不跑定位/压分）
 * - 不返回 input_token_count
 */
import { logRemoteFailure, publicRemoteError, UNPARSEABLE_RETRIES } from './remote_log.js';
import { makeLineSplitter, makeSseDeltaFeeder } from './relevance_remote_v2.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const KEYWORDS_MODEL = 'tencent/hy3';
const KEYWORDS_MAX_TOKENS = 256;

/** 模型分 1–5 → (0.2…1.0] */
const SCORE_NORMALIZE = 5;
/** 渲染 Workaround：复现亮度相对首现再压低的倍数（非评测项） */
const REPEAT_DIM_FACTOR = 5;

export const KEYWORDS_V2_PATH = '/api/v2/analyze-semantic-keywords';
/** 提示词/模型/解析变了、影响缓存准确性时加一。 */
export const KEYWORDS_CACHE_VERSION = 2;

/** SYNC: scripts/eval_semantic_keywords_remote.py → KEYWORDS_TASK_CORE */
const KEYWORDS_TASK =
  'Extract all keywords related to the query topic. ' +
  'A keyword can be a word or short phrase. ' +
  'Make sure to only extract keywords that appear in the text. ' +
  'Order them from most important to least important.';

/** SYNC: scripts/eval_semantic_keywords_remote.py → KEYWORDS_OUTPUT_FORMAT */
const KEYWORDS_OUTPUT_FORMAT =
  'Output Format: each keyword on its own line ' +
  'as [keyword]<score, 1 slightly related to 5 strongly related>. ' +
  'Nothing else.\n' +
  'Example reply:\n' +
  '[foo]5\n[bar]3';

/** SYNC: scripts/eval_semantic_keywords_remote.py → build_keywords_user_content（verbal 默认）
 * 头尾同序 Task(Reminder) → Query → Output Format。Hy3 对这段顺序敏感（相关度实测：Query 在最后会抬错检）。 */
export function buildKeywordsUserContent(query, text, formatReminder = false) {
  const queryLine = `Query: ${query}`;
  const mid = `${queryLine}\n${KEYWORDS_OUTPUT_FORMAT}`;
  const head = `Task: ${KEYWORDS_TASK}\n${mid}`;
  const reminder = `Task Reminder: ${KEYWORDS_TASK}\n${mid}`;
  let content = `${head}\nText:\n\n${text}\n\n${reminder}`;
  if (formatReminder) {
    content +=
      '\nCRITICAL: Strictly adhere to the format. Output each keyword on its own line as [keyword]<score>. Nothing else.\n' +
      'Example reply:\n' +
      '[foo]5\n[bar]3';
  }
  return content;
}

/**
 * 独立单行：`[keyword]<score>`（] 与数字之间空格可选）→ [kw, score]；失败 null。
 * score 定档 1–5。SYNC: parse_verbal_keywords 的行规则。
 * @returns {[string, number] | null}
 */
function parseSingleKeyword(line) {
  if (!line) return null;
  const m = line.trim().match(/^\[(.+)\]\s*(\d+)\s*$/);
  if (!m) return null;
  const kw = m[1].trim();
  if (!kw) return null;
  const score = Number(m[2]);
  if (!Number.isFinite(score)) return null;
  let s = Math.round(score);
  s = Math.max(1, Math.min(5, s));
  return [kw, s];
}

/**
 * SYNC: scripts/eval_semantic_keywords_remote.py → parse_verbal_keywords
 * 空/空白字符串 = 合法零词；无 content / 非字符串 / 任一非空行对不上 = 契约外 → null
 * @returns {Array<[string, number]>|null}
 */
export function parseVerbalKeywords(content) {
  if (typeof content !== 'string') return null;
  if (!content.trim()) return [];
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const p = parseSingleKeyword(line);
    if (!p) return null;
    out.push(p);
  }
  return out;
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
  return scored.map(([kw, score]) => [kw, uniquifyStep(score, taken)]);
}

/**
 * 单条增量 uniquify 定档：与 uniquifyHighScores 同规则，但共享外部 taken 集，
 * 使「逐条到达」（流式）与「整块一次」（非流式）输出逐位一致。
 * @param {number} score  原始 1–5
 * @param {Set<number>} taken  跨条目共享的已占用档位
 * @returns {number} 定档后的 1–5
 */
export function uniquifyStep(score, taken) {
  let s = score;
  while (s >= 2 && taken.has(s)) s -= 1;
  if (s >= 2) taken.add(s);
  return s;
}

/**
 * 定位 + REPEAT_DIM + 字级 max，返回该 keyword 各命中的高亮 run。
 * 顺序（与 keywordsToTokenAttention 逐条处理一致）：首现满亮、复现压暗；
 * 与已写 best[] 的字级 max 取大（供整块版用于重叠取 max / 合并）。
 * @param {string[]} textCps
 * @param {string} kw
 * @param {number} scoreInt  已 uniquify 定档 1–5
 * @param {Float64Array|null} best  整块版共享字级数组（流式传 null，只返回 runs）
 * @returns {Array<{ offset: [number, number], raw: string, score: number }>}
 */
function keywordToRuns(textCps, kw, scoreInt, best) {
  const normalized = scoreInt / SCORE_NORMALIZE;
  const runs = [];
  const hits = findAllCaseInsensitive(textCps, kw);
  for (let hi = 0; hi < hits.length; hi++) {
    const mapped = hi === 0 ? normalized : normalized / REPEAT_DIM_FACTOR;
    const [s, e] = hits[hi];
    if (best) {
      for (let i = s; i < e; i++) {
        if (mapped > best[i]) best[i] = mapped;
      }
    }
    runs.push({ offset: [s, e], raw: textCps.slice(s, e).join(''), score: mapped });
  }
  return runs;
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
  const adjusted = uniquifyHighScores(scored);
  for (const [kw, scoreInt] of adjusted) {
    keywordToRuns(textCps, kw, scoreInt, best);
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

function keywordsChatBody(query, text, stream, formatReminder = false) {
  return {
    model: KEYWORDS_MODEL,
    messages: [{ role: 'user', content: buildKeywordsUserContent(query, text, formatReminder) }],
    temperature: 0,
    max_tokens: KEYWORDS_MAX_TOKENS,
    stream,
    reasoning: { effort: 'none' },
    provider: { sort: 'latency' },
  };
}

function keywordsChatHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://info-lens.app',
    'X-Title': 'infolens-keywords-v2',
  };
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
      headers: keywordsChatHeaders(token),
      body: JSON.stringify(keywordsChatBody(query, text, false)),
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
  const raw = msg.content;
  const scored = parseVerbalKeywords(raw);
  if (scored === null) {
    throw new Error(`unparseable verbal output: ${JSON.stringify(raw)}`);
  }

  return {
    model: data.model || KEYWORDS_MODEL,
    token_attention: keywordsToTokenAttention(text, scored),
  };
}

/**
 * 流式：读 SSE 的 delta.content，按行切 `[keyword]<score>`，完整一行即：
 * ① 增量 uniquify 定档（共享 taken，与整块版逐位一致）
 * ② 定位 + REPEAT_DIM → 逐条 emit 高亮 run。
 * 空行忽略；非空行对不上格式即报错（含长截断末行残缺）；全空 = 合法零词。
 *
 * @param {object} env
 * @param {string} query
 * @param {string} text
 * @param {(event: object) => void} emit  结构化事件（type:row / type:result / type:error）
 * @param {AbortSignal} [signal]  客户端取消 → 中止 OpenRouter 流
 * @param {boolean} [formatReminder=false]  格式强化提醒（重试时启用）
 * @returns {Promise<void>}
 */
export async function streamKeywordsV2(env, query, text, emit, signal, formatReminder = false) {
  const token = (env.OPENROUTER_API_KEY || '').trim();
  if (!token) {
    throw new Error('OPENROUTER_API_KEY secret is not set');
  }

  let resp;
  try {
    resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: keywordsChatHeaders(token),
      body: JSON.stringify(keywordsChatBody(query, text, true, formatReminder)),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const m = e && e.message != null ? String(e.message) : String(e);
    throw new Error(`network: ${m}`);
  }

  const readErrBody = async () => {
    try {
      const text = await resp.text();
      return text.slice(0, 500);
    } catch {
      return '';
    }
  };

  if (resp.status >= 400 || !resp.body) {
    const detail = await readErrBody();
    throw new Error(`OpenRouter HTTP ${resp.status}: ${detail}`);
  }

  const textCps = Array.from(text);
  const taken = new Set();
  const seen = new Set();

  const onLine = (line) => {
    const s = line.trim();
    if (!s) return;
    const p = parseSingleKeyword(s);
    if (!p) {
      throw new Error(`unparseable verbal output: ${JSON.stringify(line)}`);
    }
    const [kw, score] = p;
    const key = `${kw}\x00${score}`;
    if (seen.has(key)) return;
    seen.add(key);
    const scoreInt = uniquifyStep(score, taken);
    for (const run of keywordToRuns(textCps, kw, scoreInt, null)) {
      emit({ type: 'row', offset: run.offset, raw: run.raw, score: run.score });
    }
  };
  const split = makeLineSplitter(onLine);

  const decoder = new TextDecoder();
  const sseFeeder = makeSseDeltaFeeder(split, {
    onError: (err) => {
      throw new Error(err);
    },
  });
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseFeeder(decoder.decode(value, { stream: true }));
  }
  sseFeeder('');
  split('');
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

  const query = (body && body.query) || '';
  if (!query) {
    return json(request, { success: false, message: 'Missing query' }, 400);
  }

  const text = (body && body.text) || '';
  if (!text) {
    return json(request, { success: false, message: 'Missing text' }, 400);
  }

  // 流式：SSE（text/event-stream），逐条 type:row（高亮 run），结束 type:result / 失败 type:error。
  if (body && body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sse = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        let emitted = false;
        const runStream = (reminder) => {
          return streamKeywordsV2(
            env,
            query,
            text,
            (ev) => {
              if (ev.type === 'row') {
                emitted = true;
                sse({ type: 'row', offset: ev.offset, raw: ev.raw, score: ev.score });
              }
            },
            request.signal,
            reminder
          );
        };
        try {
          const retryable = (err) =>
            err &&
            err.name !== 'AbortError' &&
            !request.signal?.aborted &&
            typeof err.message === 'string' &&
            err.message.startsWith('unparseable verbal output');
          for (let attempt = 0; attempt <= UNPARSEABLE_RETRIES; attempt++) {
            try {
              await runStream(attempt > 0);
              sse({ type: 'result', success: true });
              return;
            } catch (err) {
              if (!retryable(err)) throw err;
              await logRemoteFailure(
                'remote_keywords_v2_failed',
                err,
                publicRemoteError(err),
                env,
                request,
                { attempt: attempt + 1, retries: UNPARSEABLE_RETRIES }
              );
              // 已发出过 row：客户端当成功。零行才继续带格式提醒重试。
              if (emitted) {
                sse({ type: 'result', success: true });
                return;
              }
              if (attempt === UNPARSEABLE_RETRIES) {
                const pub = publicRemoteError(err);
                sse({
                  type: 'error',
                  success: false,
                  kind: pub.kind,
                  message: pub.message,
                  error_detail: pub.error_detail,
                });
                return;
              }
            }
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          const pub = publicRemoteError(err);
          await logRemoteFailure('remote_keywords_v2_failed', err, pub, env, request);
          sse({
            type: 'error',
            success: false,
            kind: pub.kind,
            message: pub.message,
            error_detail: pub.error_detail,
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // 非流式 JSON 路径：v2 路径启用流式前的过渡期遗留，供迁移窗口期内的旧版插件
  // （不带 stream:true，收到整块 token_attention）使用。
  // 删除时机：等「上一个仍发非流式 JSON 请求的插件版本」的用户全部完成迁移（插件商店
  // 发布 1~2 天延迟导致的过渡窗口结束、确认线上已无旧版调用）之后，即可删掉本分支与
  // chatKeywordsV2（chatKeywordsV2 仍被评测脚本引用时，评审脚本可改用流式或保留其导出）。
  try {
    const r = await chatKeywordsV2(env, query, text);
    return json(request, {
      success: true,
      model: r.model,
      token_attention: r.token_attention,
    });
  } catch (err) {
    const pub = publicRemoteError(err);
    await logRemoteFailure('remote_keywords_v2_failed', err, pub, env, request);
    return json(
      request,
      { success: false, message: pub.message, error_detail: pub.error_detail },
      503,
    );
  }
}
