const ERROR_DETAIL_MAX = 500;

/**
 * 远程推理失败粗分（message 给用户；error_detail 仅日志/反馈，不含 query/text）：
 * - network：Worker↔上游 传输层（超时、断连、fetch 失败）
 * - inference：推理 API 暂时/服务端错误（408/429/5xx、响应体内 error）
 * - internal：我方未预期（缺密钥、输出不可解析、4xx 鉴权/请求、未知）
 *
 * 扩展本地错误（正文变化、无正文等）不经此函数，见 content.js showFindError。
 * @returns {{ kind: 'network' | 'inference' | 'internal', message: string, error_detail: string }}
 */
export function publicRemoteError(err) {
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

  // 流式中断内嵌错误（HTTP 200 后的 SSE error 事件）：携带上游 code；5xx/429/408 归一时性
  const streamErr =
    raw.match(/OpenRouter stream error:/);
  if (streamErr) {
    const se = raw.match(/code=(\d+)/);
    if (se) {
      const code = parseInt(se[1], 10);
      if (code === 408 || code === 429 || code >= 500) {
        return {
          kind: 'inference',
          message: `Inference API temporarily unavailable (${code})`,
          error_detail,
        };
      }
    }
    // 无 code 或 4xx 属模型/provider 侧异常，仍是推理过程问题（非我方契约错误）
    return {
      kind: 'inference',
      message: 'Inference API temporarily unavailable',
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

  // 模型输出无法按约定解析（unparseable / 缺 tool_calls）：多为格式契约问题，重试无益；
  // 不向用户暴露具体原因，统一提示格式异常；原始输出保留在 error_detail（日志/反馈）用于诊断。
  if (
    /^unparseable /i.test(raw) ||
    /^missing tool_calls/i.test(raw)
  ) {
    return {
      kind: 'internal',
      message: 'Unparsable model output',
      error_detail,
    };
  }

  return {
    kind: 'internal',
    message: 'Unexpected analysis error',
    error_detail,
  };
}

/** 远程推理失败：结构化写入 Workers Logs（可按 kind / event 过滤） */
export function logRemoteFailure(event, err, pub) {
  const raw = err && err.message != null ? String(err.message) : String(err);
  console.error({
    event,
    kind: pub.kind,
    message: pub.message,
    // 日志可长于返回给客户端的 error_detail（后者仍截断 500）
    error_detail: raw.length <= 4000 ? raw : raw.slice(0, 3999) + '…',
  });
}
