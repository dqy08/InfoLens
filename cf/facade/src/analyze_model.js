/**
 * POST /api/analyze 的 model 白名单。公网只放行插件可选的两档，以及网站用的 default。
 * SYNC: extension/info-highlight/local/state.js → CLOUD_MODELS ids
 */
export const ANALYZE_PATH = '/api/analyze';

const ALLOWED_IDS = new Set(['gemma-3-270m', 'qwen3-0.6b']);

export function isAllowedAnalyzeModel(model) {
  if (model == null || model === '') return true;
  if (typeof model !== 'string') return false;
  const s = model.trim();
  if (!s || s.toLowerCase() === 'default') return true;
  return ALLOWED_IDS.has(s.toLowerCase());
}

/** @returns {string|null} 拒绝时的 message；JSON 都解析不了则放行给上游 */
export function analyzeModelGateMessage(bodyBuf) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (isAllowedAnalyzeModel(parsed.model)) return null;
  const raw = parsed.model;
  const shown = typeof raw === 'string' ? raw.trim() : String(raw);
  return `Unknown base model '${shown}'. Allowed: default, gemma-3-270m, qwen3-0.6b`;
}
