/**
 * 选项页「未看过」：il_options_seen_ids。
 * 与工具栏蓝点无关（工具栏只在安装/升级时亮、点一次灭，见 action-dot.js）。
 *
 * install：seen = 整份 catalog。
 * update：seen 缺省则按 IL_OPTIONS_SEED_SEEN 播种（见各插件 options-catalog.js）。
 */
(() => {
  const SEEN_KEY = 'il_options_seen_ids';

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  function storageSet(obj) {
    return chrome.storage.local.set(obj);
  }

  function asIdList(v) {
    if (!Array.isArray(v)) return null;
    return v.filter((id) => typeof id === 'string' && id);
  }

  function unseenOf(catalog, seen) {
    const have = new Set(seen);
    return catalog.filter((id) => !have.has(id));
  }

  /** 升级首次播种用；未定义则等同整份 catalog */
  function seedSeenList(catalog) {
    const seed = globalThis.IL_OPTIONS_SEED_SEEN;
    if (seed == null) return [...catalog];
    if (!Array.isArray(seed)) throw new Error('IL_OPTIONS_SEED_SEEN must be an array');
    return seed.filter((id) => typeof id === 'string' && id);
  }

  async function readSeen() {
    const res = await storageGet([SEEN_KEY]);
    return asIdList(res[SEEN_KEY]);
  }

  async function ensureSeeded(catalog) {
    const seen = await readSeen();
    if (seen) return seen;
    const seeded = seedSeenList(catalog);
    await storageSet({ [SEEN_KEY]: seeded });
    return seeded;
  }

  async function markSeen(ids, catalog) {
    if (!ids?.length) return unseenOf(catalog, await ensureSeeded(catalog));
    const seen = await ensureSeeded(catalog);
    const next = new Set(seen);
    for (const id of ids) next.add(id);
    const list = [...next];
    await storageSet({ [SEEN_KEY]: list });
    return unseenOf(catalog, list);
  }

  async function onInstalled(details, catalog) {
    if (details.reason === 'install') {
      await storageSet({ [SEEN_KEY]: [...catalog] });
      return;
    }
    const seen = await readSeen();
    if (!seen) await storageSet({ [SEEN_KEY]: seedSeenList(catalog) });
  }

  async function unseen(catalog) {
    return unseenOf(catalog, await ensureSeeded(catalog));
  }

  async function onOptionsOpen(catalog) {
    return unseen(catalog);
  }

  globalThis.IL_optionsAttention = {
    SEEN_KEY,
    unseen,
    markSeen,
    onInstalled,
    onOptionsOpen,
  };
})();
