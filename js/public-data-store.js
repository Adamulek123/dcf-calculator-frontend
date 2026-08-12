import { recordCacheEvent } from "./cache-metrics.js";

const DATABASE_NAME = "dcf-public-data";
const STORE_NAME = "records";
const MAX_BYTES = 12 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 1000;
let databasePromise;
let lastPruneAt = 0;

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
        let result = null;
        request.onsuccess = () => {
            const record = request.result;
            const now = Date.now();
            const isFresh = record?.expiresAt > now;
            const staleExpiresAt = record?.staleExpiresAt || record?.expiresAt || 0;
            if (!record || (!isFresh && (!allowExpired || staleExpiresAt <= now))) {
                if (record) store.delete(key);
                recordCacheEvent("public", record ? "expired" : "miss");
                return;
            }
            record.lastAccessed = now;
            store.put(record);
            recordCacheEvent("public", isFresh ? "hit" : "stale");
            result = { ...record, isFresh };
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
    });
}

async function getPublicRecord(key) {
    return (await getPublicEntry(key))?.data || null;
}

async function setPublicRecord(key, data, ttlMs, {
    staleTtlMs = 0,
    version = null,
    serverUpdatedAt = null,
    policyName = null,
    maxEntries = null,
    maxBytes = null,
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
        policyName,
    };
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    const shouldPrune = now - lastPruneAt >= PRUNE_INTERVAL_MS;
    if (!shouldPrune) {
        return new Promise((resolve) => {
            tx.oncomplete = () => resolve(record);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    }
    lastPruneAt = now;
    const request = store.getAll();
    request.onsuccess = () => {
        const records = request.result.sort((a, b) => a.lastAccessed - b.lastAccessed);
        const removed = new Set();
        const policyRecords = policyName ? records.filter((item) => item.policyName === policyName) : [];
        const entryLimit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : null;
        while (entryLimit !== null && policyRecords.length > entryLimit) {
            const removableIndex = policyRecords.findIndex((item) => item.key !== key);
            if (removableIndex < 0) break;
            const [item] = policyRecords.splice(removableIndex, 1);
            store.delete(item.key);
            removed.add(item.key);
        }
        let policyBytes = policyRecords.reduce((sum, item) => sum + (item.bytes || 0), 0);
        const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : null;
        for (const item of policyRecords) {
            if (byteLimit === null || policyBytes <= byteLimit) break;
            if (item.key === key || removed.has(item.key)) continue;
            store.delete(item.key);
            removed.add(item.key);
            policyBytes -= item.bytes || 0;
        }
        let total = records.reduce((sum, item) => removed.has(item.key) ? sum : sum + (item.bytes || 0), 0);
        for (const item of records) {
            if (total <= MAX_BYTES) break;
            if (item.key === key || removed.has(item.key)) continue;
            store.delete(item.key);
            removed.add(item.key);
            total -= item.bytes || 0;
        }
    };
    return new Promise((resolve) => {
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
    });
}

async function deletePublicRecord(key) {
    const database = await openDatabase();
    if (!database) return false;
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    return new Promise((resolve) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
    });
}

export { deletePublicRecord, getPublicEntry, getPublicRecord, setPublicRecord };
