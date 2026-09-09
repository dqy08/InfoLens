/**
 * chrome.storage.local 上的定额环形缓存：按条存，满员覆盖最旧格并删对应 key。
 * 只管机械部分——哈希、写串行、淘汰记账、用量统计；键的形状与条目内容由上层决定。
 * 保留两个 key：<prefix>meta（上层自定义的一坨，不进环）与 <prefix>order（占用顺序表）。
 * 无 chrome 时退回进程内存，供单测与非扩展环境。
 */
globalThis.IL_createRingStore = function IL_createRingStore({
  prefix,
  maxEntries,
  label,
  legacyKeys = [],
}) {
  const META = `${prefix}meta`;
  const ORDER = `${prefix}order`;
  const RESERVED = new Set([META, ORDER, ...legacyKeys]);
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

  function storage() {
    return globalThis.chrome?.storage?.local ?? memoryLocal;
  }

  function hex(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  async function hashStr(s) {
    return hex(await subtle.digest('SHA-256', new TextEncoder().encode(String(s)))).slice(0, 32);
  }

  function get(keys) {
    return storage().get(keys);
  }

  /** 本 store 占用的全部 key（含保留键） */
  function ownedKeys(all) {
    return Object.keys(all).filter((k) => k.startsWith(prefix) || RESERVED.has(k));
  }

  async function putNow(patch) {
    const dataKeys = Object.keys(patch).filter((k) => !RESERVED.has(k));
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
      if (keys.length < maxEntries) {
        keys.push(k);
        continue;
      }
      const slot = i % maxEntries;
      const old = keys[slot];
      if (old && old !== k) drop.push(old);
      keys[slot] = k;
      i = (slot + 1) % maxEntries;
    }
    await storage().set({ ...patch, [ORDER]: { keys, i } });
    if (drop.length) await storage().remove(drop);
  }

  /** 丢掉命中的条；环已满时先把顺序表转正，剩余按年龄重排、指针归零。 */
  async function dropWhereNow(match) {
    const raw = (await storage().get(ORDER))[ORDER];
    let keys = Array.isArray(raw?.keys) ? raw.keys : [];
    const drop = keys.filter(match);
    if (!drop.length) return;
    await storage().remove(drop);
    if (keys.length === maxEntries) {
      const i = Number.isInteger(raw?.i) && raw.i >= 0 ? raw.i % maxEntries : 0;
      keys = keys.slice(i).concat(keys.slice(0, i));
    }
    await storage().set({ [ORDER]: { keys: keys.filter((k) => !match(k)), i: 0 } });
  }

  /** 连保留键一起清。上层自己的内存态（含 clearMemory）由上层复位。 */
  async function dropAllNow() {
    const drop = ownedKeys(await storage().get(null));
    if (drop.length) await storage().remove(drop);
  }

  const tx = {
    get,
    put: putNow,
    remove: (keys) => storage().remove(keys),
    dropWhere: dropWhereNow,
    dropAll: dropAllNow,
  };

  /** 顺序表读改写串行，避免并发漏记。 */
  let writeChain = Promise.resolve();
  /** @param {(tx: typeof tx) => Promise<unknown>} fn */
  function transaction(fn) {
    const p = writeChain.then(
      () => fn(tx),
      () => fn(tx)
    );
    writeChain = p.then(
      () => {},
      () => {}
    );
    return p;
  }

  async function usage() {
    const all = await storage().get(null);
    const keys = ownedKeys(all);
    const entries = keys.filter((k) => !RESERVED.has(k)).length;
    const store = storage();
    let bytes = 0;
    if (keys.length) {
      if (typeof store.getBytesInUse === 'function') {
        bytes = await store.getBytesInUse(keys);
      } else {
        const slice = {};
        for (const k of keys) slice[k] = all[k];
        bytes = new TextEncoder().encode(JSON.stringify(slice)).length;
      }
    }
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`${label}: bad byte count ${bytes}`);
    return { entries, bytes };
  }

  /** 只丢内存兜底；storage 里的条留下（测试 / 注入重跑） */
  function clearMemory() {
    for (const k of Object.keys(mem)) delete mem[k];
  }

  return {
    MAX_ENTRIES: maxEntries,
    META_KEY: META,
    hashStr,
    get,
    put: (patch) => transaction((t) => t.put(patch)),
    remove: (keys) => transaction((t) => t.remove(keys)),
    dropWhere: (match) => transaction((t) => t.dropWhere(match)),
    dropAll: () => transaction((t) => t.dropAll()),
    transaction,
    usage,
    clearMemory,
  };
};
