/**
 * 隐藏页：加载 Gemma-3-270m ONNX q4，在 WebGPU 上做 Analyze。
 * SW 无持久内存；模型必须留在这里。
 */
import { AutoTokenizer, AutoModelForCausalLM, env } from '../vendor/transformers/transformers.js';

const MODEL_ID = globalThis.IH_localState.MODEL_ID;
const DTYPE = globalThis.IH_localState.MODEL_DTYPE;
const DEVICE = 'webgpu';
const MAX_LENGTH = 2000;
/** 单次前向 token 数。128 × 262144 × 4B ≈ 128MB，挡住 WASM 堆高水位。 */
const CHUNK_SIZE = 128;
const VERIFY = 'The cat sat.';

if (!globalThis.IH_localScoring) throw new Error('IH_localScoring missing');

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/transformers.js').replace(/[^/]+$/, '');
  env.backends.onnx.wasm.proxy = false;
}

let tokenizer = null;
let model = null;
let bosId = null;
/** @type {Set<number>} */
let specialIds = new Set();
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function specialSet(tok) {
  const ids = tok.all_special_ids;
  const out = new Set();
  if (ids && typeof ids[Symbol.iterator] === 'function') {
    for (const id of ids) out.add(Number(id));
  }
  const bos = tok.bos_token_id;
  if (bos != null) out.add(Number(bos));
  const eos = tok.eos_token_id;
  if (eos != null) out.add(Number(eos));
  const pad = tok.pad_token_id;
  if (pad != null) out.add(Number(pad));
  const unk = tok.unk_token_id;
  if (unk != null) out.add(Number(unk));
  return out;
}

function decodeOne(id) {
  return tokenizer.decode([id], { skip_special_tokens: false, clean_up_tokenization_spaces: false });
}

function tokenStr(id) {
  const t = tokenizer.model.convert_ids_to_tokens([id]);
  if (!Array.isArray(t) || t.length !== 1 || t[0] == null) {
    throw new Error(`convert_ids_to_tokens ${id}`);
  }
  return t[0];
}

function disposeTensors(obj) {
  if (!obj) return;
  for (const t of Object.values(obj)) t.dispose?.();
}

async function probe() {
  return globalThis.IH_localState.probeWebGPU();
}

async function init(hub, progress) {
  if (hub !== globalThis.IH_localState.HUB_HUGGINGFACE && hub !== globalThis.IH_localState.HUB_MODELSCOPE) {
    throw new Error(`bad hub: ${hub}`);
  }
  env.remoteHost = globalThis.IH_localState.hubRemoteHost(hub);
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: progress });
  model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
    device: DEVICE,
    dtype: DTYPE,
    progress_callback: progress,
  });
  bosId = tokenizer.bos_token_id == null ? null : Number(tokenizer.bos_token_id);
  specialIds = specialSet(tokenizer);
  const check = await analyzeText(VERIFY);
  if (!check.bpe_strings.length) throw new Error('verify produced no tokens');
  for (const t of check.bpe_strings) {
    const p = t.real_topk?.[1];
    if (!Number.isFinite(p) || p <= 0) throw new Error('verify produced non-finite probability');
  }
}

async function analyzeText(text) {
  if (!model || !tokenizer) throw new Error('local model not loaded');
  if (typeof text !== 'string' || !text) throw new Error('Missing text');

  const inputs = await tokenizer(text, {
    return_tensors: 'pt',
    truncation: true,
    max_length: MAX_LENGTH,
    add_special_tokens: true,
  });
  let past = null;
  try {
    const ids = Array.from(inputs.input_ids.data).map(Number);
    if (bosId != null && ids[0] !== bosId) {
      throw new Error('Gemma encoding missing BOS');
    }
    const utf16 = globalThis.IH_localScoring.alignUtf16Offsets(text, ids, tokenStr, specialIds);
    const offsets = globalThis.IH_localScoring.utf16ToCpOffsets(text, utf16);
    // SYNC: backend/core/language_checker.py → _encode_text truncation warn
    if (offsets.length) {
      const lastEnd = offsets[offsets.length - 1][1];
      const cpLen = globalThis.IH_localScoring.utf16ToCpOffsets(text, [[0, text.length]])[0][1];
      if (lastEnd < cpLen) {
        console.warn(
          `[Info Highlight] text truncated to first ${MAX_LENGTH} tokens (${cpLen} char -> ${lastEnd} char)`,
        );
      }
    }
    const aligned = globalThis.IH_localScoring.ensureGemmaBos(ids, offsets, bosId);

    const rows = [];
    const seq = aligned.ids.length;
    for (let start = 0; start < seq; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, seq);
      const input_ids = inputs.input_ids.slice(null, [start, end]);
      const attention_mask = inputs.attention_mask.slice(null, [0, end]);
      let outputs;
      try {
        outputs = await model({ input_ids, attention_mask, past_key_values: past });
      } finally {
        input_ids.dispose?.();
        attention_mask.dispose?.();
      }
      try {
        const logits = outputs.logits;
        const dims = (logits.dims || []).map(Number);
        if (!dims || dims.length < 3) throw new Error(`bad logits dims: ${JSON.stringify(dims)}`);
        if (dims[1] !== end - start) {
          throw new Error(`logits seq ${dims[1]} != chunk ${end - start}`);
        }
        rows.push(...globalThis.IH_localScoring.scoreChunk(
          logits.data, dims[2], aligned.ids, start, end,
        ));
      } finally {
        past = model.getPastKeyValues(outputs, past);
        outputs.logits.dispose?.();
      }
    }
    return globalThis.IH_localScoring.bpeFromRows({
      rows,
      ids: aligned.ids,
      offsets: aligned.offsets,
      text,
      decodeId: decodeOne,
    });
  } finally {
    disposeTensors(past);
    inputs.input_ids?.dispose?.();
    inputs.attention_mask?.dispose?.();
  }
}

function progressToInit(info) {
  chrome.runtime.sendMessage({ type: 'ih-local-progress', info }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ih-local-engine') return;
  const cmd = msg.cmd;
  enqueue(async () => {
    if (cmd === 'probe') return { ok: true, webgpu: await probe() };
    if (cmd === 'init') {
      await init(msg.hub, (info) => progressToInit(info));
      return { ok: true };
    }
    if (cmd === 'analyze') {
      const result = await analyzeText(msg.text);
      return { ok: true, result };
    }
    if (cmd === 'status') {
      return { ok: true, loaded: !!(model && tokenizer) };
    }
    throw new Error(`unknown engine cmd: ${cmd}`);
  })
    .then((data) => sendResponse(data))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
