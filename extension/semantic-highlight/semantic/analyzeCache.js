/**
 * 页内请求缓存：同一 query + 块文本不再打网。
 * 按条存：一条 = 一块的相关度或 keywords。相关度本窗已到的行一次写入；keywords 整段成功才写。
 * 数据按 encodeURIComponent(query)/textHash 存；il_ac/order 循环数组记占用。满员覆盖最旧格并删对应 key。
 * 删一条搜索历史时按 query 前缀丢掉对应条。
 * 打开栏后台问门面相关度 / keywords epoch，各与插件 epoch 合成；对不上只丢对应表。
 * 开搜与还原上次结果都不等待这次询问，只用当时已有的 key 决定是否走缓存。
 * 已有则留下（首次注入失败重试仍可能重跑本文件）。
 */
globalThis.IL_analyzeCache ||= (function () {
  const PREFIX = 'il_ac/';
  const OLD_BLOB = 'il_analyze_cache';
  /** 影响缓存准确性时加一。 */
  const PLUGIN_CACHE_VERSION = 2;

  const store = globalThis.IL_createRingStore({
    prefix: PREFIX,
    /** 实测约 160 字节/条；2 万条约 3MB。chrome.storage.local 上限 10MB。 */
    maxEntries: 20000,
    label: 'il_analyze_cache',
    legacyKeys: [OLD_BLOB],
  });
  const META = store.META_KEY;

  let relevanceKey = null;
  let keywordsKey = null;
  let metaReady = false;

  function queryPart(query) {
    return encodeURIComponent(String(query));
  }

  /** @param {string} query @param {string} text */
  async function key(query, text) {
    return `${queryPart(query)}/${await store.hashStr(text)}`;
  }

  function relKey(hash) {
    return `${PREFIX}r/${hash}`;
  }

  function kwKey(hash) {
    return `${PREFIX}k/${hash}`;
  }

  async function ensureMeta() {
    if (metaReady) return;
    const got = await store.get([META, OLD_BLOB]);
    const raw = got[META];
    if (raw && typeof raw === 'object') {
      if (typeof raw.relevanceKey === 'string' && raw.relevanceKey) relevanceKey = raw.relevanceKey;
      if (typeof raw.keywordsKey === 'string' && raw.keywordsKey) keywordsKey = raw.keywordsKey;
    }
    if (got[OLD_BLOB] != null) await store.remove(OLD_BLOB);
    metaReady = true;
  }

  function dropKind(kind) {
    const prefix = `${PREFIX}${kind}/`;
    return store.dropWhere((k) => k.startsWith(prefix));
  }

  function dropQuery(query) {
    const q = queryPart(query);
    return store.dropWhere(
      (k) => k.startsWith(`${PREFIX}r/${q}/`) || k.startsWith(`${PREFIX}k/${q}/`)
    );
  }

  /**
   * 一火定窗。字典序 1→2→3（8 次不在这一层）：
   * 遇洞且前缀已有匹配 → 1 已满足，2 停在连续缓存末、不打洞；
   * 遇洞且前缀尚无匹配 → 1 未满足，2 从洞起最多 maxSend（缓存前缀不占配额）；
   * 无洞 → 1、2 打平，3 收到已扫连续缓存末。
   * @param {(number | undefined)[]} degrees  与待分析窗同序；undefined = 未缓存
   * @param {number} threshold
   * @param {number} [maxSend]  从第一个未缓存块起最多取几块；默认 degrees.length
   * @returns {number} 这一火要用的块数（相对 degrees，含缓存前缀）
   */
  function cachedWindowLength(degrees, threshold, maxSend = degrees.length) {
    let prefix = 0;
    let hasMatch = false;
    for (let i = 0; i < degrees.length; i++) {
      const d = degrees[i];
      if (d == null || !Number.isFinite(d)) {
        if (hasMatch) return prefix;
        return Math.min(degrees.length, i + maxSend);
      }
      prefix = i + 1;
      if (d >= threshold) hasMatch = true;
    }
    return prefix;
  }

  /**
   * 按缓存扫完再定窗。无洞则 3 收尽剩余；遇洞交给 cachedWindowLength。
   * degrees 与已扫到的 texts 同序；长度可能短于 n（洞后未扫的未知块）。
   * @param {string} query
   * @param {string[]} texts  起点之后的全部剩余块，不要先截到 maxSend
   * @param {number} threshold
   * @param {number} [maxSend]
   * @returns {Promise<{ n: number, degrees: (number | undefined)[] }>}
   */
  async function windowPlan(query, texts, threshold, maxSend = texts.length) {
    const degrees = [];
    const step = Math.max(1, maxSend);
    const finish = (n) => ({ n, degrees: degrees.slice(0, Math.min(n, degrees.length)) });
    for (let start = 0; start < texts.length; start += step) {
      const end = Math.min(texts.length, start + step);
      const hashes = await Promise.all(texts.slice(start, end).map((t) => key(query, t)));
      const storeKeys = hashes.map(relKey);
      const got = storeKeys.length ? await store.get(storeKeys) : {};
      for (const k of storeKeys) {
        const d = got[k];
        degrees.push(Number.isFinite(d) ? d : undefined);
      }
      const n = cachedWindowLength(degrees, threshold, maxSend);
      if (n < degrees.length) return finish(n);
      const hole = degrees.findIndex((d) => d == null || !Number.isFinite(d));
      if (hole >= 0) return finish(Math.min(texts.length, hole + maxSend));
      if (end >= texts.length) return finish(n);
    }
    return finish(texts.length);
  }

  /**
   * @param {string} query
   * @param {string[]} texts
   * @param {(n: number, fullMatchDegree: number) => void} onRow
   * @param {AbortSignal} [signal]
   * @param {(query: string, texts: string[], onRow: Function, signal?: AbortSignal) => Promise<void>} send
   */
  async function relevance(query, texts, onRow, signal, send) {
    const hashes = await Promise.all(texts.map((t) => key(query, t)));
    const storeKeys = hashes.map(relKey);
    const got = storeKeys.length ? await store.get(storeKeys) : {};
    let prefix = 0;
    while (prefix < storeKeys.length) {
      const d = got[storeKeys[prefix]];
      if (!Number.isFinite(d)) break;
      onRow?.(prefix + 1, d);
      prefix += 1;
    }
    if (prefix === storeKeys.length) return;
    const patch = {};
    try {
      await send(
        query,
        texts.slice(prefix),
        (n, degree) => {
          const i = prefix + n - 1;
          if (i < 0 || i >= storeKeys.length) return;
          patch[storeKeys[i]] = degree;
          onRow?.(i + 1, degree);
        },
        signal
      );
    } finally {
      if (Object.keys(patch).length) await store.put(patch);
    }
  }

  /**
   * @param {string} query
   * @param {string} text
   * @param {(run: { offset: [number, number], score: number }) => void} onRun
   * @param {AbortSignal} [signal]
   * @param {(query: string, text: string, onRun: Function, signal?: AbortSignal) => Promise<void>} send
   */
  async function keywords(query, text, onRun, signal, send) {
    const sk = kwKey(await key(query, text));
    const cached = (await store.get(sk))[sk];
    if (Array.isArray(cached)) {
      for (const run of cached) onRun?.(run);
      return;
    }
    /** @type {{ offset: [number, number], score: number }[]} */
    const acc = [];
    await send(
      query,
      text,
      (run) => {
        const offset = run?.offset;
        acc.push({
          offset: Array.isArray(offset) ? [offset[0], offset[1]] : offset,
          score: run?.score ?? 0,
        });
        onRun?.(run);
      },
      signal
    );
    await store.put({ [sk]: acc });
  }

  function epochKey(n) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('il_analyze_cache: bad facade version');
    }
    return `${PLUGIN_CACHE_VERSION}:${n}`;
  }

  /**
   * 问门面两个 epoch，与插件 epoch 合成 key；对不上只丢对应表。fetch 失败不改 key。
   * @param {() => Promise<{ relevance: number, keywords: number }>} fetchFacadeVersion
   */
  async function syncRemoteModel(fetchFacadeVersion) {
    await ensureMeta();
    const ver = await fetchFacadeVersion();
    const nextRel = epochKey(ver?.relevance);
    const nextKw = epochKey(ver?.keywords);
    if (relevanceKey != null && relevanceKey !== nextRel) await dropKind('r');
    if (keywordsKey != null && keywordsKey !== nextKw) await dropKind('k');
    relevanceKey = nextRel;
    keywordsKey = nextKw;
    await store.put({ [META]: { relevanceKey, keywordsKey } });
  }

  /** 只丢本模块内存；storage 里的条留下（测试 / 注入重跑）。 */
  function clear() {
    relevanceKey = null;
    keywordsKey = null;
    metaReady = false;
    store.clearMemory();
  }

  async function dropAll() {
    await store.dropAll();
    clear();
  }

  return {
    key,
    MAX_ENTRIES: store.MAX_ENTRIES,
    cachedWindowLength,
    windowPlan,
    relevance,
    keywords,
    syncRemoteModel,
    usage: store.usage,
    dropQuery,
    dropAll,
    clear,
  };
})();
