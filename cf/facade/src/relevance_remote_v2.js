/**
 * 远程 relevance v2：OpenRouter Chat（Hy3）→ 隐含多切片 whole-article 单次请求 → 每片 degree。
 * 路径 /api/v2/analyze-semantic-relevance；只走边缘远程，无本地/HF 回退（与 keywords v2 同轨）。
 *
 * 流式：向 OpenRouter 开 stream:true，边读边按 '\n' 切行，每出完整一行 [N]count
 * 即 emit 结构化 SSE 事件（type:row）；凑齐 texts.length 后 abort 上游（忽略尾部多余行）；
 * 正常收尾 emit type:result / 失败 type:error。契约为 SSE（v1 单 text 仍供旧扩展）。
 *
 * CPU 开销：本处理器同步计算只有 JSON 解析 + 提示词拼接 + 逐行切分；远低于 Free 10ms 上限。
 */
import { logRemoteFailure, publicRemoteError, UNPARSEABLE_RETRIES } from './remote_log.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const RELEVANCE_MODEL = 'tencent/hy3';
/** 多切片：一个上下文最多容纳的 chunk 数（整篇不足则全载）。结论见 eval 脚本。 */
const MULTI_CHUNK_MAX = 32;
/** 单切片字节上限。SYNC: 前端 config chunkBytes=800（splitTextToChunks 按此切，主线上每块 ≤800B） */
const CHUNK_BYTE_MAX = 800;
/** 多行输出：每 chunk 约 8 token（[N] 数），与上下文组上限对应。SYNC 脚本 DEFAULT_MULTI_CHUNK_MAX_TOKENS */
const MAX_TOKENS_PER_CHUNK = 8;

export const RELEVANCE_V2_PATH = '/api/v2/analyze-semantic-relevance';
/** 提示词/模型/解析变了、影响缓存准确性时加一。 */
export const RELEVANCE_CACHE_VERSION = 5;

/** SYNC: scripts/eval_semantic_relevance_remote.py → build_multi_chunk_user_content（正式版，格式两次）。
 * 正文前缀 Passage N:（不用 [N]，避免与文中 [N] 冲突）；回复仍为 [N]<count>。
 * 头尾同序：Task(Reminder) → Query → Output Format；正文夹在中间。
 * Hy3 对这段顺序敏感、会影响门控精度：Query 若顶在生成口会更积极认相关、错检升；
 * 本序（Format 在最后）与旧「尾段单独贴 Format」精度相当。不要改成 Task→Format→Query。
 * 基线 task；曾尝试追加全文判定句（"A word's relevance ... in the whole article"）但实测增误放行、
 * 对真相关零增益，故回退不再采用（详见 eval 脚本注释）。 */
export function buildMultiChunkUserContent(query, chunks, formatReminder = false) {
  const task =
    'The passages are consecutive slices of one complete article, in reading order. ' +
    'How many words in each passage are related to the query topic?';
  const outputFormat =
    'Output Format: each passage on its own line ' +
    'as [N]<count, 0 if not related>, where N is the passage index. Nothing else.\n' +
    'Example reply for 3 passages:\n' +
    '[1]0\n[2]0\n[3]3';
  const queryLine = `Query: ${query}`;
  const mid = `${queryLine}\n${outputFormat}`;
  const head = `Task: ${task}\n${mid}`;
  const reminder = `Task Reminder: ${task}\n${mid}`;
  const passages = chunks.map((text, i) => `Passage ${i + 1}: ${text}`).join('\n');
  let content = `${head}\nArticle:\n\n${passages}\n\n${reminder}`;
  if (formatReminder) {
    const n = chunks.length;
    let example;
    if (n === 1) {
      example = '[1]0';
    } else if (n === 2) {
      example = '[1]0\n[2]1';
    } else if (n === 3) {
      example = '[1]0\n[2]1\n[3]0';
    } else {
      example = `[1]0\n[2]1\n...\n[${n}]0`;
    }
    content +=
      `\nCRITICAL: Strictly adhere to the format. Output EXACTLY ${n} lines, from [1] to [${n}]. Nothing else.\n` +
      `Example reply for ${n} passages:\n` +
      `${example}`;
  }
  return content;
}

/**
 * 独立单行解析：`[N]数字`（空格可选）→ {n, count}，失败返回 null。
 * 供逐行流式与 parseMultiChunkCounts 复用同一正则（DRY）。
 * @returns {{ n: number, count: number } | null}
 */
function parseSingleCount(line) {
  if (!line) return null;
  const re = /^\[(\d+)\]\s*(\d+)/;
  const m = line.trim().match(re);
  if (!m) return null;
  return { n: parseInt(m[1], 10), count: parseInt(m[2], 10) };
}

/**
 * 从整段解析 `[N]数字`（整块非流式场景的基线版）。SYNC: parse_multi_chunk_counts
 * 流式主线上已改为逐行连续校验（emitRow），本函数保持宽松 Map 解析供对照/供评测基线。
 * @returns {{counts: Map<number, number>, raw: string} | null}
 */
export function parseMultiChunkCounts(content) {
  if (!content || typeof content !== 'string') return null;
  const counts = new Map();
  for (const line of content.split('\n')) {
    const p = parseSingleCount(line);
    if (p) counts.set(p.n, p.count);
  }
  return { counts, raw: content };
}

/**
 * 对流式输出做按行切分：把增量文本按 '\n' 切出完整行，每切出完整一行即回调。
 * 行末断开的残留留在 buffer，等后续 chunk 补齐。
 *
 * 返回的 push 函数带一个 falsy 申明：传空串表示"冲刷"，把残留的最后一段也 emit。
 * @param {(line: string) => void} onLine
 * @returns {(chunk: string) => void}
 */
export function makeLineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) onLine(line);
    if (!chunk && buffer.length) {
      // 空串冲刷：最后一段没有换行的残留也算一整行
      onLine(buffer);
      buffer = '';
    }
  };
}

/**
 * 流式版本：向 OpenRouter stream:true，读 SSE，边收 delta.content 边按行切，
 * 每出完整 `[N]count` 行就 emit 一次。
 *
 * @param {object} env
 * @param {string} query
 * @param {string[]} chunks
 * @param {(event: object) => void} emit  结构化事件回调（type:row / type:result / type:error）
 * @param {AbortSignal} [signal]  客户端取消 → 中止 OpenRouter 流，停止继续生成
 * @param {boolean} [formatReminder=false]  格式强化提醒：是否在提示词尾部强申明具体行数与输出示例（重试时启用）
 * @returns {Promise<void>}
 */
export async function streamRelevanceV2(env, query, chunks, emit, signal, formatReminder = false) {
  const token = (env.OPENROUTER_API_KEY || '').trim();
  if (!token) {
    throw new Error('OPENROUTER_API_KEY secret is not set');
  }

  // 本地控制器：客户端 signal 与「凑齐后主动停流」共用，避免凑齐后仍等模型把多余行吐完。
  const localAc = new AbortController();
  if (signal) {
    if (signal.aborted) {
      const e = new Error('search stopped');
      e.name = 'AbortError';
      throw e;
    }
    signal.addEventListener('abort', () => localAc.abort(), { once: true });
  }

  let resp;
  try {
    resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://info-lens.app',
        'X-Title': 'infolens-relevance-v2',
      },
      body: JSON.stringify({
        model: RELEVANCE_MODEL,
        messages: [{ role: 'user', content: buildMultiChunkUserContent(query, chunks, formatReminder) }],
        temperature: 0,
        max_tokens: Math.max(MULTI_CHUNK_MAX * MAX_TOKENS_PER_CHUNK, 16 * chunks.length),
        stream: true,
        reasoning: { effort: 'none' },
      }),
      signal: localAc.signal,
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

  const decoder = new TextDecoder();
  const counts = new Map();
  const rawLines = [];
  // 连续校验游标：契约要求从 [1] 起逐块连续输出 `[N]<count>`，直到凑齐 texts.length。
  // 凑齐前：跳号/乱序/重复/说明文字 → 格式异常（优先报错）。
  // 凑齐后：任务完成——忽略尾部多行，并 abort 上游停止继续生成。
  let expectedN = 1;
  const emitRow = (line) => {
    if (expectedN > chunks.length) return;
    // 收集模型原始输出行：解析可靠时仍留档，失败时用于诊断（随错误记录）
    const s = line.trim();
    if (s) rawLines.push(s);
    const p = parseSingleCount(line);
    if (!p || p.n !== expectedN) {
      const rawSuffix = rawLines.length ? `\n--- raw output ---\n${rawLines.join('\n')}` : '';
      throw new Error(`unparseable multi-chunk output: expected [${expectedN}] count, got ${JSON.stringify(line)}${rawSuffix}`);
    }
    expectedN++;
    counts.set(p.n, p.count);
    emit({ type: 'row', n: p.n, count: p.count });
    if (expectedN > chunks.length) localAc.abort();
  };
  const split = makeLineSplitter(emitRow);

  const reader = resp.body.getReader();
  // 流式中断（HTTP 200 内嵌 error 事件）：显式抛出真实原因，不再静默等到收尾误报 unparseable
  const sseFeeder = makeSseDeltaFeeder(split, {
    onError: (err) => {
      const rawSuffix = rawLines.length ? `\n--- raw output ---\n${rawLines.join('\n')}` : '';
      throw new Error(`${err}${rawSuffix}`);
    },
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseFeeder(decoder.decode(value, { stream: true }));
      if (expectedN > chunks.length) break;
    }
    // 未凑齐才冲刷：凑齐后可能已 abort，buffer 里即便有尾部垃圾也不再解析
    if (expectedN - 1 < chunks.length) {
      sseFeeder('');
      split('');
    }
  } catch (e) {
    // 凑齐后主动 abort 会让 read 抛 AbortError：属正常收尾，不外抛（否则门面会静默不发 result）
    if (!(e && e.name === 'AbortError' && expectedN - 1 >= chunks.length)) throw e;
  }

  // 收尾校验：未走满 = 中途断流致末尾缺行
  if (expectedN - 1 < chunks.length) {
    const rawSuffix = rawLines.length ? `\n--- raw output ---\n${rawLines.join('\n')}` : '';
    throw new Error(`unparseable multi-chunk output${rawSuffix}`);
  }
}

/**
 * SSE 帧级解码：把 OpenRouter streaming 的 `data: {json}` 行切出来，
 * 取每条帧的增量文本交给内容层（onDelta）。跨 chunk 累积：SSE 帧可能被
 * 任意字节边界切开，需 buffer 到完整行再处理。
 *
 * OpenRouter 流式中断（HTTP 200 已承诺）的错误以 SSE 事件内嵌返回：
 * 顶层 `error` 字段、或 `choices[0].finish_reason === 'error'`。这类事件
 * 无增量文本，必须显式上报 onError，否则只会被静默跳过，最终被收尾校验
 * 误报成 unparseable（丢失真实原因）。
 *
 * @param {(delta: string) => void} onDelta
 * @param {{ onError?: (err: string) => void }} [opts]
 *   onError(err) 收到流式错误事件时回调；省略则直接 throw（禁止静默跳过）
 * @returns {(text: string) => void}
 */
export function makeSseDeltaFeeder(onDelta, opts) {
  const onError = opts?.onError;
  /** 未传 onError 时直接抛：避免再静默跳过错误帧（本函数曾因此把上游故障误报成 unparseable） */
  const reportStreamError = (msg) => {
    if (onError) onError(msg);
    else throw new Error(msg);
  };
  let buffer = '';
  const flushLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const payload = s.slice(5).trim();
    if (payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    // 流式中断的错误事件：OpenRouter 顶层 error + finish_reason=error；显式上抛而非静默忽略
    if (parsed && parsed.error) {
      const e = parsed.error;
      const detail =
        typeof e.message === 'string'
          ? // code 裸写（勿 JSON.stringify）：字符串 "502" 否则变成 code="502"，publicRemoteError 的 /code=(\d+)/ 抽不出
            `code=${e.code != null && e.code !== '' ? String(e.code) : ''} message=${JSON.stringify(e.message)}`
          : JSON.stringify(e);
      reportStreamError(`OpenRouter stream error: ${detail}`);
      return;
    }
    const choice = (parsed.choices && parsed.choices[0]) || {};
    if (choice.finish_reason === 'error') {
      const fr = choice.native_finish_reason ? ` native_finish_reason=${JSON.stringify(choice.native_finish_reason)}` : '';
      reportStreamError(`OpenRouter stream error: finish_reason=error${fr}`);
      return;
    }
    const d = (choice.delta || {}).content;
    if (typeof d === 'string' && d) {
      onDelta(d);
    }
  };
  return (text) => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) flushLine(line);
    if (!text && buffer.length) {
      // 冲刷：SSE 残留帧行（未以换行结束）
      flushLine(buffer);
      buffer = '';
    }
  };
}

/** @param {(req: Request, body: object, status?: number) => Response} json */
export async function handleRemoteRelevanceV2(request, env, json) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method_not_allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { success: false, message: 'invalid json' }, 400);
  }

  const query = (body && body.query) || '';
  if (!query) {
    return json(request, { success: false, message: 'Missing query' }, 400);
  }

  const texts = body && body.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return json(request, { success: false, message: 'Missing texts array' }, 400);
  }
  if (texts.length > MULTI_CHUNK_MAX) {
    return json(
      request,
      { success: false, message: `texts length must be <= ${MULTI_CHUNK_MAX}` },
      400,
    );
  }
  const enc = new TextEncoder();
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== 'string' || !t) {
      return json(request, { success: false, message: `texts[${i}] must be a non-empty string` }, 400);
    }
    if (enc.encode(t).length > CHUNK_BYTE_MAX) {
      return json(request, { success: false, message: `texts[${i}] must be <= ${CHUNK_BYTE_MAX} bytes` }, 400);
    }
  }

  // 流式响应：SSE（text/event-stream）。逐行出 type:row（每片 full_match_degree），结束 type:result / 失败 type:error。
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sse = (obj) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
        );
      };
      let emittedN = 0;
      const runStream = (offset, reminder) => {
        const remainingTexts = texts.slice(offset);
        if (remainingTexts.length === 0) return Promise.resolve();
        return streamRelevanceV2(
          env,
          query,
          remainingTexts,
          (ev) => {
            if (ev.type === 'row') {
              const actualN = offset + ev.n;
              emittedN = actualN;
              sse({ type: 'row', n: actualN, full_match_degree: ev.count > 0 ? 1.0 : 0.0 });
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
          err.message.startsWith('unparseable multi-chunk output');
        for (let attempt = 0; attempt <= UNPARSEABLE_RETRIES; attempt++) {
          try {
            await runStream(emittedN, attempt > 0);
            sse({ type: 'result', success: true });
            return;
          } catch (err) {
            if (!retryable(err)) throw err;
            await logRemoteFailure(
              'remote_relevance_v2_failed',
              err,
              publicRemoteError(err),
              env,
              request,
              { attempt: attempt + 1, retries: UNPARSEABLE_RETRIES }
            );
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
        // 用户取消（客户端断连）不应视为失败：不发 error、不记失败日志，静默收尾
        if (err && err.name === 'AbortError') return;
        const pub = publicRemoteError(err);
        await logRemoteFailure('remote_relevance_v2_failed', err, pub, env, request);
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
