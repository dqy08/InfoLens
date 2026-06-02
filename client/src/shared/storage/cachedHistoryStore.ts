export type CacheNamespace = 'chat' | 'attribution' | 'gen_attr';
export type CacheStatus = 'partial' | 'complete';

/** 仅存业务数据，不含 MRU 时间戳 */
type PayloadRow = {
    id: string;
    namespace: CacheNamespace;
    contentKey: string;
    businessKeyJson: string;
    listLabel: string;
    payload: unknown;
    status: CacheStatus;
    createdAt: number;
};

/** 每 namespace 一条：keyOrder 为 contentKey 序列，末尾为最近使用 */
type MruRow = {
    namespace: CacheNamespace;
    keyOrder: string[];
};

/** 与旧版 `InfoRadarCache` 分离，避免沿用有问题的升级路径；旧库可随浏览器站点数据清理 */
const DB_NAME = 'InfoRadarSharedCache';
const DB_VERSION = 1;
const STORE_PAYLOADS = 'payloads';
const STORE_MRU = 'mru_order';

let dbPromise: Promise<IDBDatabase> | null = null;

function simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function rowId(namespace: CacheNamespace, contentKey: string): string {
    return `${namespace}:${contentKey}`;
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_PAYLOADS)) {
                db.createObjectStore(STORE_PAYLOADS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_MRU)) {
                db.createObjectStore(STORE_MRU, { keyPath: 'namespace' });
            }
        };
    });
}

async function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = openDb().catch((e) => {
            dbPromise = null;
            throw e;
        });
    }
    return dbPromise;
}

async function readMru(tx: IDBTransaction, namespace: CacheNamespace): Promise<string[]> {
    const row = await promisifyRequest(tx.objectStore(STORE_MRU).get(namespace) as IDBRequest<MruRow | undefined>);
    return Array.isArray(row?.keyOrder) ? row.keyOrder : [];
}

async function writeMru(tx: IDBTransaction, namespace: CacheNamespace, keyOrder: string[]): Promise<void> {
    await promisifyRequest(tx.objectStore(STORE_MRU).put({ namespace, keyOrder } satisfies MruRow));
}

export type CachedHistoryEntry<T> = {
    contentKey: string;
    businessKeyJson: string;
    listLabel: string;
    payload: T;
    status: CacheStatus;
    createdAt: number;
};

/** 下拉列表一行：id 为 {@link CachedHistoryEntry.contentKey}，label 为展示文案 */
export type CachedHistoryListRow = Pick<CachedHistoryEntry<unknown>, 'contentKey' | 'listLabel'>;

export function buildContentKeyFromBusinessKey(businessKey: unknown): string {
    return simpleHash(JSON.stringify(businessKey));
}

function payloadRowToEntry<T>(row: PayloadRow): CachedHistoryEntry<T> {
    return {
        contentKey: row.contentKey,
        businessKeyJson: row.businessKeyJson,
        listLabel: row.listLabel,
        payload: row.payload as T,
        status: row.status,
        createdAt: row.createdAt,
    };
}

export async function getByContentKey<T>(
    namespace: CacheNamespace,
    contentKey: string
): Promise<CachedHistoryEntry<T> | undefined> {
    const db = await getDb();
    const tx = db.transaction(STORE_PAYLOADS, 'readonly');
    const row = await promisifyRequest(
        tx.objectStore(STORE_PAYLOADS).get(rowId(namespace, contentKey)) as IDBRequest<PayloadRow | undefined>
    );
    await promisifyTransaction(tx);
    if (!row) return undefined;
    return payloadRowToEntry<T>(row);
}

export async function upsertEntry<T>(params: {
    namespace: CacheNamespace;
    businessKeyJson: string;
    listLabel: string;
    payload: T;
    status: CacheStatus;
    maxEntries: number;
}): Promise<{ contentKey: string }> {
    const { namespace, businessKeyJson, listLabel, payload, status, maxEntries } = params;
    const contentKey = simpleHash(businessKeyJson);
    const id = rowId(namespace, contentKey);
    const db = await getDb();
    const tx = db.transaction([STORE_PAYLOADS, STORE_MRU], 'readwrite');
    const payloadStore = tx.objectStore(STORE_PAYLOADS);
    const existing = await promisifyRequest(payloadStore.get(id) as IDBRequest<PayloadRow | undefined>);
    const now = Date.now();
    const hadKey = !!existing;

    let keyOrder = await readMru(tx, namespace);
    const idx = keyOrder.indexOf(contentKey);
    if (idx >= 0) keyOrder.splice(idx, 1);

    if (keyOrder.length >= maxEntries && !hadKey) {
        const oldest = keyOrder.shift();
        if (oldest !== undefined) {
            await promisifyRequest(payloadStore.delete(rowId(namespace, oldest)));
        }
    }

    await promisifyRequest(
        payloadStore.put({
            id,
            namespace,
            contentKey,
            businessKeyJson,
            listLabel,
            payload,
            status,
            createdAt: existing?.createdAt ?? now,
        } satisfies PayloadRow)
    );
    keyOrder.push(contentKey);
    await writeMru(tx, namespace, keyOrder);
    await promisifyTransaction(tx);
    return { contentKey };
}

export async function touchByContentKey(namespace: CacheNamespace, contentKey: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction([STORE_PAYLOADS, STORE_MRU], 'readwrite');
    const payloadStore = tx.objectStore(STORE_PAYLOADS);
    const exists = await promisifyRequest(payloadStore.get(rowId(namespace, contentKey)) as IDBRequest<PayloadRow | undefined>);
    if (!exists) {
        await promisifyTransaction(tx);
        return;
    }
    let keyOrder = await readMru(tx, namespace);
    const idx = keyOrder.indexOf(contentKey);
    if (idx >= 0) keyOrder.splice(idx, 1);
    keyOrder.push(contentKey);
    await writeMru(tx, namespace, keyOrder);
    await promisifyTransaction(tx);
}

export async function patchPayloadRow(
    namespace: CacheNamespace,
    contentKey: string,
    patch: { businessKeyJson?: string; listLabel?: string; payload?: unknown }
): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(STORE_PAYLOADS, 'readwrite');
    const store = tx.objectStore(STORE_PAYLOADS);
    const row = await promisifyRequest(
        store.get(rowId(namespace, contentKey)) as IDBRequest<PayloadRow | undefined>
    );
    if (!row) {
        await promisifyTransaction(tx);
        return;
    }
    if (patch.businessKeyJson !== undefined) row.businessKeyJson = patch.businessKeyJson;
    if (patch.listLabel !== undefined) row.listLabel = patch.listLabel;
    if (patch.payload !== undefined) row.payload = patch.payload;
    await promisifyRequest(store.put(row));
    await promisifyTransaction(tx);
}

export async function removeByContentKey(namespace: CacheNamespace, contentKey: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction([STORE_PAYLOADS, STORE_MRU], 'readwrite');
    await promisifyRequest(tx.objectStore(STORE_PAYLOADS).delete(rowId(namespace, contentKey)));
    let keyOrder = await readMru(tx, namespace);
    keyOrder = keyOrder.filter((k) => k !== contentKey);
    await writeMru(tx, namespace, keyOrder);
    await promisifyTransaction(tx);
}

export async function listMru<T>(namespace: CacheNamespace): Promise<Array<CachedHistoryEntry<T>>> {
    const db = await getDb();
    const tx = db.transaction([STORE_PAYLOADS, STORE_MRU], 'readonly');
    const keyOrder = await readMru(tx, namespace);
    const payloadStore = tx.objectStore(STORE_PAYLOADS);
    const result: Array<CachedHistoryEntry<T>> = [];
    for (let i = keyOrder.length - 1; i >= 0; i--) {
        const ck = keyOrder[i];
        const row = await promisifyRequest(payloadStore.get(rowId(namespace, ck)) as IDBRequest<PayloadRow | undefined>);
        if (row) result.push(payloadRowToEntry<T>(row));
    }
    await promisifyTransaction(tx);
    return result;
}
