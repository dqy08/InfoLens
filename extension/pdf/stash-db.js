/**
 * 扩展源 IndexedDB：PDF 字节暂存（SW 写入，查看器读取；刷新可复用同一 id）。
 * 清理：超过 7 天删除；自管总量上限 100MB（仅 1 条时可超过）；浏览器 QuotaExceeded 时删最旧重试。
 * SW：importScripts；查看器：<script>；均挂到 globalThis.IL_pdfStash*。
 */
(() => {
  const DB_NAME = 'il-pdf-stash';
  const DB_VERSION = 2;
  const STORE = 'pdfs';
  const CHUNK_STORE = 'pdfChunks';
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  /** 多条目时的总字节软上限；只剩 1 条时不受此限（允许单个大 PDF） */
  const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
  const BUDGET_RETRY_MAX = 64;
  const QUOTA_RETRY_MAX = 32;

  /** @returns {Promise<IDBDatabase>} */
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const chunks = db.createObjectStore(CHUNK_STORE, { keyPath: ['id', 'index'] });
          chunks.createIndex('id', 'id', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  /**
   * @template T
   * @param {IDBRequest<T>} req
   * @returns {Promise<T>}
   */
  function reqDone(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
    });
  }

  /** @param {IDBTransaction} tx */
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexedDB tx failed'));
      tx.onabort = () => reject(tx.error || new Error('indexedDB tx aborted'));
    });
  }

  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, mode);
      const done = txDone(tx);
      const result = await fn(tx.objectStore(STORE));
      await done;
      return result;
    } finally {
      db.close();
    }
  }

  async function withStores(mode, fn) {
    const db = await openDb();
    try {
      const tx = db.transaction([STORE, CHUNK_STORE], mode);
      const done = txDone(tx);
      const result = await fn(tx.objectStore(STORE), tx.objectStore(CHUNK_STORE));
      await done;
      return result;
    } finally {
      db.close();
    }
  }

  function deleteChunks(chunks, id) {
    const req = chunks.index('id').openCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  }

  /** 删除 createdAt 早于截止时刻的条目 */
  async function cleanupExpired() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const db = await openDb();
    try {
      const tx = db.transaction([STORE, CHUNK_STORE], 'readwrite');
      const done = txDone(tx);
      const index = tx.objectStore(STORE).index('createdAt');
      const range = IDBKeyRange.upperBound(cutoff, true);
      await new Promise((resolve, reject) => {
        const curReq = index.openCursor(range);
        curReq.onerror = () => reject(curReq.error);
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          deleteChunks(tx.objectStore(CHUNK_STORE), cursor.primaryKey);
          cursor.delete();
          cursor.continue();
        };
      });
      await done;
    } finally {
      db.close();
    }
  }

  /** @returns {Promise<boolean>} 是否删掉了一条 */
  async function deleteOldestOne() {
    const db = await openDb();
    try {
      const tx = db.transaction([STORE, CHUNK_STORE], 'readwrite');
      const done = txDone(tx);
      const index = tx.objectStore(STORE).index('createdAt');
      const deleted = await new Promise((resolve, reject) => {
        const curReq = index.openCursor();
        curReq.onerror = () => reject(curReq.error);
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (!cursor) {
            resolve(false);
            return;
          }
          deleteChunks(tx.objectStore(CHUNK_STORE), cursor.primaryKey);
          cursor.delete();
          resolve(true);
        };
      });
      await done;
      return deleted;
    } finally {
      db.close();
    }
  }

  /** @returns {Promise<{ count: number, totalBytes: number }>} */
  async function storeStats() {
    return withStore('readonly', async (store) => {
      let count = 0;
      let totalBytes = 0;
      await new Promise((resolve, reject) => {
        const curReq = store.openCursor();
        curReq.onerror = () => reject(curReq.error);
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          count += 1;
          const row = cursor.value;
          const n =
            typeof row.byteLength === 'number'
              ? row.byteLength
              : row.data && typeof row.data.byteLength === 'number'
                ? row.data.byteLength
                : 0;
          totalBytes += n;
          cursor.continue();
        };
      });
      return { count, totalBytes };
    });
  }

  /**
   * 总量超过 100MB 且条目数 > 1：按 createdAt 删最旧，直到 ≤100MB 或只剩 1 条。
   * 单独一条（哪怕 >100MB）不删。
   */
  async function cleanupOverBudget() {
    for (let i = 0; i < BUDGET_RETRY_MAX; i++) {
      const { count, totalBytes } = await storeStats();
      if (count <= 1 || totalBytes <= MAX_TOTAL_BYTES) return;
      if (!(await deleteOldestOne())) return;
    }
  }

  /**
   * @param {{ id: string, data: ArrayBuffer, fileName: string, createdAt: number, byteLength: number }} record
   */
  async function putRecord(record) {
    await withStore('readwrite', (store) => reqDone(store.put(record)));
  }

  async function putWithQuotaRetry(record) {
    for (let i = 0; i < QUOTA_RETRY_MAX; i++) {
      try {
        await putRecord(record);
        return;
      } catch (err) {
        const name = err && err.name;
        if (name !== 'QuotaExceededError' && name !== 'NS_ERROR_DOM_QUOTA_REACHED') throw err;
        if (!(await deleteOldestOne())) throw err;
      }
    }
    throw new Error('PDF stash: storage full');
  }

  /**
   * @param {{ id: string, data: ArrayBuffer, fileName?: string }} entry
   * @returns {Promise<string>} id
   */
  async function putPdf(entry) {
    if (!entry?.id || !(entry.data instanceof ArrayBuffer)) {
      throw new Error('PDF stash: invalid entry');
    }
    await cleanupExpired();
    await putWithQuotaRetry({
      id: entry.id,
      data: entry.data,
      fileName: entry.fileName || 'document.pdf',
      createdAt: Date.now(),
      byteLength: entry.data.byteLength,
    });
    await cleanupOverBudget();
    return entry.id;
  }

  /** Base64 分块上传：入口页持有站点会话，SW 只做持久化，避免跨上下文传 ArrayBuffer。 */
  async function startPdfUpload(entry) {
    if (!entry?.id) throw new Error('PDF stash: invalid upload');
    await cleanupExpired();
    await putRecord({
      id: entry.id,
      fileName: entry.fileName || 'document.pdf',
      createdAt: Date.now(),
      byteLength: 0,
      chunkCount: null,
    });
  }

  async function appendPdfUploadChunk(entry) {
    if (
      !entry?.id ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      typeof entry.base64 !== 'string' ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 1
    ) {
      throw new Error('PDF stash: invalid upload chunk');
    }
    await withStores('readwrite', (_pdfs, chunks) =>
      reqDone(chunks.put({
        id: entry.id,
        index: entry.index,
        base64: entry.base64,
        byteLength: entry.byteLength,
      }))
    );
  }

  async function finishPdfUpload(entry) {
    if (
      !entry?.id ||
      !Number.isInteger(entry.chunkCount) ||
      entry.chunkCount < 1 ||
      !Number.isInteger(entry.byteLength) ||
      entry.byteLength < 5
    ) {
      throw new Error('PDF stash: invalid upload finish');
    }
    await withStore('readwrite', async (store) => {
      const record = await reqDone(store.get(entry.id));
      if (!record) throw new Error('PDF stash: upload missing');
      record.byteLength = entry.byteLength;
      record.chunkCount = entry.chunkCount;
      await reqDone(store.put(record));
    });
    await cleanupOverBudget();
  }

  function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function readUploadedPdf(row) {
    const chunks = await withStores('readonly', async (_pdfs, chunkStore) => {
      const out = [];
      await new Promise((resolve, reject) => {
        const req = chunkStore.index('id').openCursor(IDBKeyRange.only(row.id));
        req.onerror = () => reject(req.error || new Error('PDF stash: chunk read failed'));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          out.push(cursor.value);
          cursor.continue();
        };
      });
      return out;
    });
    if (chunks.length !== row.chunkCount) return null;
    let offset = 0;
    const data = new Uint8Array(row.byteLength);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].index !== i) return null;
      const bytes = decodeBase64(chunks[i].base64);
      if (bytes.byteLength !== chunks[i].byteLength || offset + bytes.byteLength > data.byteLength) return null;
      data.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return offset === data.byteLength ? data.buffer : null;
  }

  /**
   * @param {string} id
   * @returns {Promise<null | { data: ArrayBuffer, fileName: string, createdAt: number }>}
   */
  async function getPdf(id) {
    if (!id) return null;
    const row = await withStore('readonly', (store) => reqDone(store.get(id)));
    if (!row) return null;
    let data = row.chunkCount == null ? row.data : await readUploadedPdf(row);
    if (!data) return null;
    if (data instanceof Blob) {
      data = await data.arrayBuffer();
    } else if (ArrayBuffer.isView(data)) {
      data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (!(data instanceof ArrayBuffer)) return null;
    if (typeof row.createdAt === 'number' && Date.now() - row.createdAt > MAX_AGE_MS) {
      try {
        await withStores('readwrite', (store, chunks) => {
          deleteChunks(chunks, id);
          return reqDone(store.delete(id));
        });
      } catch {
        /* ignore */
      }
      return null;
    }
    return {
      data,
      fileName: row.fileName || 'document.pdf',
      createdAt: row.createdAt,
    };
  }

  globalThis.IL_pdfStashPut = putPdf;
  globalThis.IL_pdfStashGet = getPdf;
  globalThis.IL_pdfStashStartUpload = startPdfUpload;
  globalThis.IL_pdfStashAppendUploadChunk = appendPdfUploadChunk;
  globalThis.IL_pdfStashFinishUpload = finishPdfUpload;
  globalThis.IL_pdfStashCleanup = async () => {
    await cleanupExpired();
    await cleanupOverBudget();
  };
})();
