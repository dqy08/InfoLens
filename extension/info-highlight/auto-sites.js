/**
 * 自动分析的站点名单：hostname 精确匹配（子域各算各的）。
 * 名单在 chrome.storage.local，host 权限在 Chrome 手上——用户可在扩展详情页单独撤销，
 * 故要跑之前以 granted() 为准，名单只当用户意图看。
 */
globalThis.IH_autoSites ||= (function () {
  const KEY = 'ih_auto_sites';

  /** 只有普通 http(s) 页进自动路径；PDF、file:、受限页由调用方另外挡 */
  function hostOf(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  }

  /** 选项页手填：hostname 或完整 URL，抽出 hostname；非法则 null */
  function parseHost(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    return hostOf(s.includes('://') ? s : `https://${s}`);
  }

  // 一次授权覆盖 http 与 https。manifest 的 optional_host_permissions 也须用通配 scheme 的单条，
  // 拆成 http、https 两条则都不是它的超集，permissions.request 会被 Chrome 拒掉。
  function originPattern(host) {
    return `*://${host}/*`;
  }

  async function list() {
    const res = await chrome.storage.local.get({ [KEY]: [] });
    const raw = res[KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((h) => typeof h === 'string' && h);
  }

  async function has(host) {
    return !!host && (await list()).includes(host);
  }

  /** 调用前须已拿到 host 权限 */
  async function add(host) {
    const cur = await list();
    if (cur.includes(host)) return;
    await chrome.storage.local.set({ [KEY]: [...cur, host].sort() });
  }

  async function remove(host) {
    const cur = await list();
    await chrome.storage.local.set({ [KEY]: cur.filter((h) => h !== host) });
    await chrome.permissions.remove({ origins: [originPattern(host)] });
  }

  async function granted(host) {
    if (!(await has(host))) return false;
    return chrome.permissions.contains({ origins: [originPattern(host)] });
  }

  return { KEY, hostOf, parseHost, originPattern, list, has, add, remove, granted };
})();
