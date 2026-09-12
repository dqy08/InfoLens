/**
 * 分析缓存：同一请求文本不再打网。
 * 一条 = 接口返回的请求相对 token（offset + 概率）。调用方命中后再映射到当前文档。
 * 悬停用的 raw / pred_topk 只在未命中的返回值里，不写盘。
 * 按 textHash 存；淘汰记账见 shared/cache/ring-store.js。
 * 插件 epoch 对不上则整表丢掉。已有则留下（首次注入失败重试仍可能重跑本文件）。
 */
globalThis.IH_analyzeCache ||= (function () {
  const PREFIX = 'ih_ac/';
  /** 影响缓存准确性时加一。 */
  const PLUGIN_CACHE_VERSION = 5;

  const store = globalThis.IL_createRingStore({
    prefix: PREFIX,
    /** 本段条约 15KB；200 条约 3MB。chrome.storage.local 上限 10MB。 */
    maxEntries: 200,
    label: 'ih_analyze_cache',
  });

  let metaReady = false;

  /** @param {string} text */
  function key(text) {
    return store.hashStr(text);
  }

  function dataKey(hash) {
    return `${PREFIX}t/${hash}`;
  }

  function invalidateIfStale() {
    if (metaReady) return Promise.resolve();
    return store.transaction(async (tx) => {
      if (metaReady) return;
      const raw = (await tx.get(store.META_KEY))[store.META_KEY];
      if (raw != null && raw.v !== PLUGIN_CACHE_VERSION) await tx.dropAll();
      metaReady = true;
    });
  }

  function slimTokens(tokens) {
    if (!Array.isArray(tokens)) throw new Error('ih_analyze_cache: tokens not array');
    return tokens.map((tok) => {
      const off = tok?.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('ih_analyze_cache: token missing offset');
      }
      const p = Number.isFinite(tok.p) ? tok.p : tok.real_topk?.[1];
      return {
        offset: [off[0], off[1]],
        p: Number.isFinite(p) ? p : null,
      };
    });
  }

  /**
   * @param {string} text
   * @param {(text: string) => Promise<unknown[]>} send
   */
  async function tokens(text, send) {
    await invalidateIfStale();
    const sk = dataKey(await key(text));
    const cached = (await store.get(sk))[sk];
    if (Array.isArray(cached)) return cached;
    const incoming = await send(text);
    const slim = slimTokens(incoming);
    await store.put({ [sk]: slim, [store.META_KEY]: { v: PLUGIN_CACHE_VERSION } });
    return slim.map((row, i) => ({
      ...row,
      raw: typeof incoming[i].raw === 'string' ? incoming[i].raw : '',
      pred_topk: Array.isArray(incoming[i].pred_topk) ? incoming[i].pred_topk : [],
    }));
  }

  async function usage() {
    await invalidateIfStale();
    return store.usage();
  }

  async function dropAll() {
    await store.dropAll();
    clear();
  }

  function clear() {
    metaReady = false;
    store.clearMemory();
  }

  return {
    key,
    MAX_ENTRIES: store.MAX_ENTRIES,
    tokens,
    usage,
    dropAll,
    clear,
  };
})();
