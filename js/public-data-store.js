import { recordCacheEvent } from "./cache-metrics.js";

const DATABASE_NAME = "dcf-public-data";
const STORE_NAME = "records";
const MAX_BYTES = 12 * 1024 * 1024;
let databasePromise;

function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
        if (!globalThis.indexedDB) return resolve(null);
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex("lastAccessed", "lastAccessed");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
    return databasePromise;
}

function sizeOf(value) {
    try { return new Blob([JSON.stringify(value)]).size; } catch { return 0; }
}

async function getPublicEntry(key, { allowExpired = false } = {}) {
    const database = await openDatabase();
    if (!database) return null;
    return new Promise((resolve) => {
        const tx = database.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
            const record = request.result;
            const now = Date.now();
            const isFresh = record?.expiresAt > now;
            const staleExpiresAt = record?.staleExpiresAt || record?.expiresAt || 0;
            if (!record || (!isFresh && (!allowExpired || staleExpiresAt <= now))) {
                if (record) store.delete(key);
                recordCacheEvent("public", record ? "expired" : "miss");
                return resolve(null);
            }
            record.lastAccessed = now;
            store.put(record);
            recordCacheEvent("public", isFresh ? "hit" : "stale");
            resolve({ ...record, isFresh });
        };
        request.onerror = () => resolve(null);
    });
}

async function getPublicRecord(key) {
    return (await getPublicEntry(key))?.data || null;
}

async function setPublicRecord(key, data, ttlMs, {
    staleTtlMs = 0,
    version = null,
    serverUpdatedAt = null,
} = {}) {
    const database = await openDatabase();
    if (!database) return null;
    const now = Date.now();
    const record = {
        key,
        data,
        cachedAt: now,
        expiresAt: now + ttlMs,
        staleExpiresAt: now + ttlMs + Math.max(0, staleTtlMs),
        lastAccessed: now,
        bytes: sizeOf(data),
        version,
        serverUpdatedAt,
    };
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    const request = store.getAll();
    request.onsuccess = () => {
        const records = request.result.sort((a, b) => a.lastAccessed - b.lastAccessed);
        let total = records.reduce((sum, item) => sum + (item.bytes || 0), 0);
        for (const item of records) {
            if (total <= MAX_BYTES) break;
            if (item.key === key) continue;
            store.delete(item.key);
            total -= item.bytes || 0;
        }
    };
    return record;
}

async function deletePublicRecord(key) {
    const database = await openDatabase();
    if (!database) return;
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
}

export { deletePublicRecord, getPublicEntry, getPublicRecord, setPublicRecord };
