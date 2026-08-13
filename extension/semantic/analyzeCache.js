/**
 * 页内请求缓存：同一 query + 块文本不再打网。
 * 按条存：一条 = 一块的相关度或 keywords。相关度本窗已到的行一次写入；keywords 整段成功才写。
 * 数据按 hash 存；il_ac/order 循环数组记占用。满员覆盖最旧格并删对应 key。
 * 打开栏后台问门面相关度 / keywords epoch，各与插件 epoch 合成；对不上只丢对应表。
 * 开搜与还原上次结果都不等待这次询问，只用当时已有的 key 决定是否走缓存。
 * 已有则留下（首次注入失败重试仍可能重跑本文件）。
 */
globalThis.IL_analyzeCache ||= (function () {
  const PREFIX = 'il_ac/';
  const META = 'il_ac/meta';
  const ORDER = 'il_ac/order';
  const OLD_BLOB = 'il_analyze_cache';
  /** 影响缓存准确性时加一。 */
  const PLUGIN_CACHE_VERSION = 1;
  /** 约 1MB / 每条数百字节。 */
  const MAX_ENTRIES = 2000;
  const subtle = globalThis.crypto.subtle;

  const mem = Object.create(null);
  const memoryLocal = {
    async get(key) {
      if (key == null) return { ...mem };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) {
          if (k in mem) out[k] = mem[k];
        }
        return out;
      }
      return { [key]: mem[key] };
    },
    async set(obj) {
      Object.assign(mem, obj);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete mem[k];
    },
  };

  let relevanceKey = null;
  let keywordsKey = null;
  let metaReady = false;

  function hex(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  /** @param {string} query @param {string} text */
  async function key(query, text) {
    const bytes = new TextEncoder().encode(String(query) + '\0' + String(text));
    return hex(await subtle.digest('SHA-256', bytes));
  }

  function storage() {
    return globalThis.chrome?.storage?.local ?? memoryLocal;
  }

  function relKey(hash) {
    return `${PREFIX}r/${hash}`;
  }

  function kwKey(hash) {
    return `${PREFIX}k/${hash}`;
  }

  async function ensureMeta() {
    if (metaReady) return;
    const got = await storage().get([META, OLD_BLOB]);
    const raw = got[META];
    if (raw && typeof raw === 'object') {
      if (typeof raw.relevanceKey === 'string' && raw.relevanceKey) relevanceKey = raw.relevanceKey;
      if (typeof raw.keywordsKey === 'string' && raw.keywordsKey) keywordsKey = raw.keywordsKey;
    }
    if (got[OLD_BLOB] != null) await storage().remove(OLD_BLOB);
    metaReady = true;
  }

  /** 顺序表读改写串行，避免并发漏记。 */
  let writeChain = Promise.resolve();
  function enqueueWrite(fn) {
    const p = writeChain.then(fn, fn);
    writeChain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  function put(patch) {
    return enqueueWrite(() => putNow(patch));
  }

  async function putNow(patch) {
    const dataKeys = Object.keys(patch).filter((k) => k !== META);
    if (!dataKeys.length) {
      await storage().set(patch);
      return;
    }
    const raw = (await storage().get(ORDER))[ORDER];
    const keys = Array.isArray(raw?.keys) ? raw.keys.slice() : [];
    let i = Number.isInteger(raw?.i) && raw.i >= 0 ? raw.i : 0;
    const drop = [];
    for (const k of dataKeys) {
      if (keys.includes(k)) continue;
      if (keys.length < MAX_ENTRIES) {
        keys.push(k);
        continue;
      }
      const slot = i % MAX_ENTRIES;
      const old = keys[slot];
      if (old && old !== k) drop.push(old);
      keys[slot] = k;
      i = (slot + 1) % MAX_ENTRIES;
    }
    await storage().set({ ...patch, [ORDER]: { keys, i } });
    if (drop.length) await storage().remove(drop);
  }

  function dropKind(kind) {
    return enqueueWrite(async () => {
      const prefix = `${PREFIX}${kind}/`;
      const raw = (await storage().get(ORDER))[ORDER];
      let keys = Array.isArray(raw?.keys) ? raw.keys : [];
      const drop = keys.filter((k) => k.startsWith(prefix));
      if (!drop.length) return;
      await storage().remove(drop);
      if (keys.length === MAX_ENTRIES) {
        const i = Number.isInteger(raw?.i) && raw.i >= 0 ? raw.i % MAX_ENTRIES : 0;
        keys = keys.slice(i).concat(keys.slice(0, i));
      }
      await storage().set({
        [ORDER]: { keys: keys.filter((k) => !k.startsWith(prefix)), i: 0 },
      });
    });
  }

  /**
   * 一火定窗。前缀已缓存且已有匹配：收到连续缓存末。
   * 前缀已缓存尚无匹配：从第一个洞起再取 maxSend 块（缓存前缀不占请求配额）。
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
   * 按缓存规则一次定出要用几块（含本地回放的前缀）。
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
      const got = storeKeys.length ? await storage().get(storeKeys) : {};
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
    const got = storeKeys.length ? await storage().get(storeKeys) : {};
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
      if (Object.keys(patch).length) await put(patch);
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
    const cached = (await storage().get(sk))[sk];
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
    await put({ [sk]: acc });
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
    await put({ [META]: { relevanceKey, keywordsKey } });
  }

  function clear() {
    relevanceKey = null;
    keywordsKey = null;
    metaReady = false;
    for (const k of Object.keys(mem)) delete mem[k];
  }

  return {
    key,
    MAX_ENTRIES,
    cachedWindowLength,
    windowPlan,
    relevance,
    keywords,
    syncRemoteModel,
    clear,
  };
})();
