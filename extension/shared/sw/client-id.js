/**
 * 产品级匿名 client_id：本地缓存 + GET /api/client-id（Cookie il_aid，跨重装/两插件/官网共用）。
 * 门面 Cookie 为 SameSite=None; Secure，故扩展无需为 api 声明 host_permissions 也能 credentials 同步；失败则退化为本地 id。
 */
const IL_CLIENT_ID_KEY = 'il_client_id';
const IL_CLIENT_ID_PATH = '/api/client-id';
const IL_CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @type {Promise<string> | null} */
let _ilClientIdPromise = null;

function IL_isValidClientId(v) {
  return typeof v === 'string' && IL_CLIENT_ID_RE.test(v.trim());
}

function IL_storageGetClientId() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([IL_CLIENT_ID_KEY], (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = res?.[IL_CLIENT_ID_KEY];
      resolve(IL_isValidClientId(v) ? String(v).trim().toLowerCase() : null);
    });
  });
}

function IL_storageSetClientId(id) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [IL_CLIENT_ID_KEY]: id }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * 向门面取 id：带 Cookie 的 GET，服务端有 Cookie 则回显，否则新发并 Set-Cookie。
 * @param {string} apiBase
 * @returns {Promise<string | null>}
 */
async function IL_fetchClientId(apiBase) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base) return null;
  const res = await fetch(`${base}${IL_CLIENT_ID_PATH}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const id = data?.client_id;
  return IL_isValidClientId(id) ? String(id).trim().toLowerCase() : null;
}

/**
 * 缓存优先：有本地 id 就直接用，只有首次（含重装后）才问门面。
 * @param {string} [apiBase]
 * @returns {Promise<string>}
 */
globalThis.IL_getClientId = function IL_getClientId(apiBase) {
  if (_ilClientIdPromise) return _ilClientIdPromise;
  _ilClientIdPromise = (async () => {
    let cached = null;
    try {
      cached = await IL_storageGetClientId();
    } catch {
      cached = null;
    }
    if (cached) return cached;

    let id = null;
    try {
      id = await IL_fetchClientId(apiBase);
    } catch {
      /* 离线或无 host 权限：本地新建，与门面 Cookie 可能不一致 */
    }
    if (!id) id = crypto.randomUUID().toLowerCase();

    try {
      await IL_storageSetClientId(id);
    } catch {
      /* 仍返回 id，供本会话上报 */
    }
    return id;
  })().catch((err) => {
    _ilClientIdPromise = null;
    throw err;
  });
  return _ilClientIdPromise;
};
