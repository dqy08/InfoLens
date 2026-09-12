/**
 * 本机分析状态：WebGPU 探测、用户偏好、模型是否就绪、权重下载源。
 * 写入 chrome.storage.local。权重在 Cache API（transformers-cache），不进 chrome.storage。
 */
globalThis.IH_localState ||= (function () {
  const PREF_AUTO = 'auto';
  const PREF_CLOUD = 'cloud';
  const PREF_LOCAL = 'local';
  const HUB_HUGGINGFACE = 'huggingface';
  const HUB_MODELSCOPE = 'modelscope';
  const KEYS = {
    webgpu: 'ih_webgpu_ok',
    pref: 'ih_analyze_pref',
    ready: 'ih_local_ready',
    hub: 'ih_model_hub',
  };
  const MODEL_ID = 'onnx-community/gemma-3-270m-ONNX';
  const MODEL_DTYPE = 'q4';
  /** 与 @huggingface/transformers hub.js `caches.open` 一致。 */
  const MODEL_CACHE = 'transformers-cache';
  const HUBS = {
    huggingface: {
      remoteHost: 'https://huggingface.co/',
      origins: [
        'https://huggingface.co/*',
        'https://*.huggingface.co/*',
        'https://*.hf.co/*',
        'https://*.xethub.hf.co/*',
      ],
    },
    modelscope: {
      remoteHost: 'https://www.modelscope.cn/models/',
      origins: ['https://*.modelscope.cn/*'],
    },
  };

  function get() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(
        { [KEYS.webgpu]: null, [KEYS.pref]: PREF_AUTO, [KEYS.ready]: false, [KEYS.hub]: HUB_HUGGINGFACE },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve({
            webgpuOk: res[KEYS.webgpu],
            pref: normalizePref(res[KEYS.pref]),
            ready: !!res[KEYS.ready],
            hub: normalizeHub(res[KEYS.hub]),
          });
        },
      );
    });
  }

  function set(patch) {
    const out = {};
    if ('webgpuOk' in patch) out[KEYS.webgpu] = patch.webgpuOk;
    if ('pref' in patch) {
      if (patch.pref !== PREF_AUTO && patch.pref !== PREF_CLOUD && patch.pref !== PREF_LOCAL) {
        throw new Error(`bad analyze pref: ${patch.pref}`);
      }
      out[KEYS.pref] = patch.pref;
    }
    if ('hub' in patch) out[KEYS.hub] = normalizeHub(patch.hub);
    if ('ready' in patch) out[KEYS.ready] = !!patch.ready;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(out, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function normalizePref(p) {
    if (p === PREF_CLOUD || p === PREF_LOCAL) return p;
    return PREF_AUTO;
  }

  function normalizeHub(h) {
    if (h === HUB_MODELSCOPE) return HUB_MODELSCOPE;
    return HUB_HUGGINGFACE;
  }

  function hubOrigins(h) {
    return HUBS[normalizeHub(h)].origins;
  }

  function hubRemoteHost(h) {
    return HUBS[normalizeHub(h)].remoteHost;
  }

  async function probeWebGPU() {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return false;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      device.destroy?.();
      return true;
    } catch {
      return false;
    }
  }

  function cacheApi() {
    if (typeof caches === 'undefined') throw new Error('Cache API unavailable');
    return caches;
  }

  async function modelCacheUsage() {
    const api = cacheApi();
    if (!(await api.has(MODEL_CACHE))) return { entries: 0, bytes: 0 };
    const cache = await api.open(MODEL_CACHE);
    const keys = await cache.keys();
    const needle = `/${MODEL_ID}/`;
    let entries = 0;
    let bytes = 0;
    for (const req of keys) {
      const url = req.url || '';
      if (!url.includes(needle)) continue;
      entries += 1;
      const res = await cache.match(req);
      if (!res) continue;
      const raw = res.headers.get('Content-Length');
      if (raw != null && raw !== '') {
        const cl = Number(raw);
        if (Number.isFinite(cl) && cl >= 0) {
          bytes += cl;
          continue;
        }
      }
      bytes += (await res.blob()).size;
    }
    return { entries, bytes };
  }

  async function dropModelCache() {
    await cacheApi().delete(MODEL_CACHE);
  }

  return {
    PREF_AUTO,
    PREF_CLOUD,
    PREF_LOCAL,
    HUB_HUGGINGFACE,
    HUB_MODELSCOPE,
    KEYS,
    MODEL_ID,
    MODEL_DTYPE,
    MODEL_CACHE,
    get,
    set,
    normalizePref,
    normalizeHub,
    hubOrigins,
    hubRemoteHost,
    probeWebGPU,
    modelCacheUsage,
    dropModelCache,
  };
})();
