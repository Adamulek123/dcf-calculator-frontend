import { CACHE_POLICIES } from "./cache-policy.js";
import { recordCacheEvent } from "./cache-metrics.js";

const DATABASE_NAME = "dcf-client-data";
const DATABASE_VERSION = 1;
const ENTRY_STORE = "entries";
const ENVELOPE_SCHEMA_VERSION = 1;
const CACHE_CHANNEL_NAME = "dcf-data-updates-v1";
const CACHE_STORAGE_EVENT_KEY = "dcf_data_update_signal_v1";
const CACHE_MESSAGE_TYPES = new Set(["portfolio-updated", "watchlist-updated", "signed-out"]);

const CACHE_TTL = Object.freeze({
    portfolioIndex: CACHE_POLICIES.portfolioIndex.ttlMs,
    portfolioDetail: CACHE_POLICIES.portfolioDetail.ttlMs,
    portfolioOutbox: CACHE_POLICIES.portfolioOutbox.ttlMs,
    watchlists: CACHE_POLICIES.watchlists.ttlMs,
    dipPerformance: CACHE_POLICIES.dipPerformance.ttlMs,
    fxRates: CACHE_POLICIES.fxRates.ttlMs,
    savedCalculations: CACHE_POLICIES.savedCalculations.ttlMs,
    calculationOutbox: CACHE_POLICIES.calculationOutbox.ttlMs,
    calculationDeadLetters: CACHE_POLICIES.calculationDeadLetters.ttlMs,
});

const CACHE_STALE_TTL = Object.freeze({
    portfolioIndex: CACHE_POLICIES.portfolioIndex.staleTtlMs,
    portfolioDetail: CACHE_POLICIES.portfolioDetail.staleTtlMs,
    portfolioOutbox: CACHE_POLICIES.portfolioOutbox.staleTtlMs,
    watchlists: CACHE_POLICIES.watchlists.staleTtlMs,
    dipPerformance: CACHE_POLICIES.dipPerformance.staleTtlMs,
    fxRates: CACHE_POLICIES.fxRates.staleTtlMs,
    savedCalculations: CACHE_POLICIES.savedCalculations.staleTtlMs,
    calculationOutbox: CACHE_POLICIES.calculationOutbox.staleTtlMs,
    calculationDeadLetters: CACHE_POLICIES.calculationDeadLetters.staleTtlMs,
});

const memoryEntries = new Map();
let databasePromise;
const DURABLE_ENTRY_EXPIRY = Number.MAX_SAFE_INTEGER;
const PRIVATE_CACHE_LIMITS = Object.freeze({
    portfolioIndex: CACHE_POLICIES.portfolioIndex.maxEntries,
    portfolioDetail: CACHE_POLICIES.portfolioDetail.maxEntries,
    portfolioOutbox: CACHE_POLICIES.portfolioOutbox.maxEntries,
    watchlists: CACHE_POLICIES.watchlists.maxEntries,
    dipPerformance: CACHE_POLICIES.dipPerformance.maxEntries,
    fxRates: CACHE_POLICIES.fxRates.maxEntries,
    savedCalculations: CACHE_POLICIES.savedCalculations.maxEntries,
    calculationOutbox: CACHE_POLICIES.calculationOutbox.maxEntries,
    calculationDeadLetters: CACHE_POLICIES.calculationDeadLetters.maxEntries,
});

function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!globalThis.indexedDB) {
        // Do not memoize an unavailable API. Some embedded browsers expose
        // IndexedDB after the page has initialized, and the store should be
        // able to recover from an early memory-only call.
        return null;
    }

    databasePromise = new Promise((resolve) => {
        const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            const store = database.objectStoreNames.contains(ENTRY_STORE)
                ? request.transaction.objectStore(ENTRY_STORE)
                : database.createObjectStore(ENTRY_STORE, { keyPath: "key" });
            if (!store.indexNames.contains("uid")) store.createIndex("uid", "uid", { unique: false });
            if (!store.indexNames.contains("cachedAt")) store.createIndex("cachedAt", "cachedAt", { unique: false });
            if (!store.indexNames.contains("expiresAt")) store.createIndex("expiresAt", "expiresAt", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            console.warn("IndexedDB client cache is unavailable", request.error);
            resolve(null);
        };
        request.onblocked = () => {
            console.warn("IndexedDB client cache upgrade is blocked by another tab");
        };
    });
    return databasePromise;
}

async function runTransaction(mode, operation) {
    const database = await openDatabase();
    if (!database) return undefined;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(ENTRY_STORE, mode);
        const store = transaction.objectStore(ENTRY_STORE);
        let result;
        try {
            result = operation(store);
        } catch (error) {
            reject(error);
            return;
        }
        transaction.oncomplete = () => resolve(result?.result);
        transaction.onerror = () => reject(transaction.error || result?.error);
        transaction.onabort = () => reject(transaction.error || new Error("Client cache transaction aborted."));
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function assertUid(uid) {
    const normalized = String(uid || "").trim();
    if (!normalized) throw new TypeError("A Firebase UID is required for private client data.");
    return normalized;
}

function assertScopedKey(uid, key) {
    const normalized = String(key || "");
    const marker = `:${uid}`;
    if (!normalized.includes(marker)
        || (!normalized.endsWith(marker) && !normalized.includes(`${marker}:`))) {
        throw new TypeError("Private client-data keys must include the active Firebase UID.");
    }
    return normalized;
}

function validEnvelope(entry, uid, key) {
    return Boolean(entry)
        && entry.key === key
        && entry.uid === uid
        && entry.schemaVersion === ENVELOPE_SCHEMA_VERSION
        && Number.isFinite(entry.cachedAt)
        && Number.isFinite(entry.expiresAt)
        && Object.prototype.hasOwnProperty.call(entry, "data");
}

function createKeys(uid) {
    const encode = (value) => encodeURIComponent(String(value || ""));
    return Object.freeze({
        portfolioIndex: () => `portfolio-index:${uid}`,
        portfolio: (portfolioId) => `portfolio:${uid}:${encode(portfolioId)}`,
        portfolioOutbox: (portfolioId) => `portfolio-outbox:${uid}:${encode(portfolioId)}`,
        watchlists: () => `watchlists:${uid}`,
        fxRates: (base = "USD") => `fx-rates:${uid}:${encode(String(base).toUpperCase())}`,
        dipPerformance: (resultKey) => `dip-performance:${uid}:${encode(resultKey)}`,
        calculations: () => `saved-calculations:${uid}`,
        calculationOutbox: () => `calculation-outbox:${uid}`,
        calculationDeadLetters: () => `calculation-dead-letters:${uid}`,
    });
}

async function runTransactionWithStatus(mode, operation) {
    const database = await openDatabase();
    if (!database) return { completed: false, result: undefined };
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(ENTRY_STORE, mode);
        const store = transaction.objectStore(ENTRY_STORE);
        let result;
        try {
            result = operation(store);
        } catch (error) {
            reject(error);
            return;
        }
        transaction.oncomplete = () => resolve({ completed: true, result: result?.result });
        transaction.onerror = () => reject(transaction.error || result?.error);
        transaction.onabort = () => reject(transaction.error || new Error("Client cache transaction aborted."));
    });
}

function cacheFamilyForKey(uid, key) {
    const prefix = String(key || "");
    const scoped = (name) => `${name}:${uid}`;
    if (prefix === scoped("portfolio-index")) return "portfolioIndex";
    if (prefix.startsWith(`${scoped("portfolio-outbox")}:`)) return "portfolioOutbox";
    if (prefix.startsWith(`${scoped("portfolio")}:`)) return "portfolioDetail";
    if (prefix === scoped("watchlists")) return "watchlists";
    if (prefix.startsWith(`${scoped("dip-performance")}:`)) return "dipPerformance";
    if (prefix.startsWith(`${scoped("fx-rates")}:`)) return "fxRates";
    if (prefix === scoped("saved-calculations")) return "savedCalculations";
    if (prefix === scoped("calculation-outbox")) return "calculationOutbox";
    if (prefix === scoped("calculation-dead-letters")) return "calculationDeadLetters";
    return null;
}

function isMutationQueueKey(key) {
    const value = String(key || "");
    return value.startsWith("portfolio-outbox:")
        || value.startsWith("calculation-outbox:")
        || value.startsWith("calculation-dead-letters:");
}

function estimateEntryBytes(entry) {
    try {
        return new TextEncoder().encode(JSON.stringify(entry?.data ?? null)).byteLength;
    } catch {
        try { return JSON.stringify(entry?.data ?? null).length * 2; } catch { return 0; }
    }
}

function createDipPerformanceResultKey(watchlist) {
    const watchlistId = String(watchlist?.id || "").trim();
    if (!watchlistId) throw new TypeError("A watchlist ID is required for a performance cache key.");
    const roster = [...new Set((watchlist?.tickers || [])
        .map((ticker) => String(ticker || "").trim().toUpperCase())
        .filter(Boolean))]
        .sort()
        .join(",");
    let hash = 2166136261;
    for (let index = 0; index < roster.length; index += 1) {
        hash ^= roster.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${watchlistId}:${(hash >>> 0).toString(36)}`;
}

function createUserDataStore(rawUid, { now = () => Date.now() } = {}) {
    const uid = assertUid(rawUid);
    const keys = createKeys(uid);

    function limitForKey(scopedKey, { maxEntries = null, maxBytes = null, policyName = null } = {}) {
        const family = policyName || cacheFamilyForKey(uid, scopedKey);
        return {
            family,
            maxEntries: Number.isFinite(maxEntries)
                ? Math.max(1, Math.floor(maxEntries))
                : (family ? PRIVATE_CACHE_LIMITS[family] : null),
            maxBytes: Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : null,
        };
    }

    async function prunePrivateEntries(scopedKey, limits) {
        if (!limits.family || (!Number.isFinite(limits.maxEntries) && !Number.isFinite(limits.maxBytes))) {
            return;
        }

        const matches = (entry) => entry?.uid === uid
            && cacheFamilyForKey(uid, entry.key) === limits.family;
        const sortNewest = (left, right) => Number(right.cachedAt || 0) - Number(left.cachedAt || 0);
        const retained = [...memoryEntries.values()]
            .filter(matches)
            .sort(sortNewest);
        const removeKeys = new Set();
        if (Number.isFinite(limits.maxEntries)) {
            retained.slice(limits.maxEntries).forEach((entry) => removeKeys.add(entry.key));
        }
        if (Number.isFinite(limits.maxBytes)) {
            let bytes = 0;
            retained.forEach((entry) => {
                if (removeKeys.has(entry.key)) return;
                const entryBytes = estimateEntryBytes(entry);
                if (bytes > 0 && bytes + entryBytes > limits.maxBytes) removeKeys.add(entry.key);
                else bytes += entryBytes;
            });
        }
        removeKeys.forEach((key) => memoryEntries.delete(key));
        if (!removeKeys.size) return;

        const database = await openDatabase();
        if (!database) return;
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(ENTRY_STORE, "readwrite");
            const cursor = transaction.objectStore(ENTRY_STORE).openCursor();
            cursor.onsuccess = () => {
                const current = cursor.result;
                if (!current) return;
                if (removeKeys.has(current.key) && current.value?.uid === uid) current.delete();
                current.continue();
            };
            cursor.onerror = () => reject(cursor.error);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error("Client cache pruning aborted."));
        });
    }

    async function remove(key) {
        const scopedKey = assertScopedKey(uid, key);
        memoryEntries.delete(scopedKey);
        try {
            const result = await runTransactionWithStatus("readwrite", (store) => store.delete(scopedKey));
            return { key: scopedKey, persisted: result.completed === true };
        } catch (error) {
            console.warn(`Unable to remove client cache entry ${scopedKey}`, error);
            return { key: scopedKey, persisted: false, error };
        }
    }

    async function get(key, { allowExpired = true } = {}) {
        const scopedKey = assertScopedKey(uid, key);
        let entry = memoryEntries.get(scopedKey);
        let loadedFromDatabase = false;
        if (!entry) {
            try {
                const database = await openDatabase();
                if (database) {
                    const transaction = database.transaction(ENTRY_STORE, "readonly");
                    entry = await requestResult(transaction.objectStore(ENTRY_STORE).get(scopedKey));
                    loadedFromDatabase = Boolean(entry);
                }
            } catch (error) {
                console.warn(`Unable to read client cache entry ${scopedKey}`, error);
            }
        }

        if (!validEnvelope(entry, uid, scopedKey)) {
            if (entry) await remove(scopedKey);
            recordCacheEvent("uid", "miss");
            return null;
        }
        if (isMutationQueueKey(scopedKey)
            && (entry.expiresAt !== DURABLE_ENTRY_EXPIRY || entry.staleExpiresAt !== DURABLE_ENTRY_EXPIRY)) {
            entry = {
                ...entry,
                expiresAt: DURABLE_ENTRY_EXPIRY,
                staleExpiresAt: DURABLE_ENTRY_EXPIRY,
            };
            try {
                await runTransaction("readwrite", (store) => store.put(entry));
            } catch (error) {
                console.warn(`Unable to upgrade mutation queue durability for ${scopedKey}`, error);
            }
        }
        if (loadedFromDatabase) entry = { ...entry, persisted: true };
        memoryEntries.set(scopedKey, entry);
        const timestamp = now();
        const isFresh = entry.expiresAt > timestamp;
        const staleExpiresAt = Number.isFinite(entry.staleExpiresAt)
            ? entry.staleExpiresAt
            : entry.expiresAt;
        if (!isFresh && staleExpiresAt <= timestamp) {
            await remove(scopedKey);
            recordCacheEvent("uid", "expired");
            return null;
        }
        if (!allowExpired && !isFresh) {
            recordCacheEvent("uid", "stale-rejected");
            return null;
        }
        recordCacheEvent("uid", isFresh ? "hit" : "stale");
        return { ...entry, isFresh };
    }

    async function set(key, data, {
        ttlMs,
        staleTtlMs = 0,
        serverUpdatedAt = null,
        version = null,
        durable = false,
        maxEntries = null,
        maxBytes = null,
        policyName = null,
    } = {}) {
        const scopedKey = assertScopedKey(uid, key);
        if (!Number.isFinite(ttlMs) || ttlMs < 0) {
            throw new TypeError("Client cache entries require a non-negative ttlMs.");
        }
        if (!Number.isFinite(staleTtlMs) || staleTtlMs < 0) {
            throw new TypeError("Client cache entries require a non-negative staleTtlMs.");
        }
        const cachedAt = now();
        const entry = {
            key: scopedKey,
            schemaVersion: ENVELOPE_SCHEMA_VERSION,
            uid,
            cachedAt,
            expiresAt: durable || isMutationQueueKey(scopedKey)
                ? DURABLE_ENTRY_EXPIRY
                : cachedAt + ttlMs,
            staleExpiresAt: durable || isMutationQueueKey(scopedKey)
                ? DURABLE_ENTRY_EXPIRY
                : cachedAt + ttlMs + staleTtlMs,
            serverUpdatedAt,
            version,
            data,
        };
        memoryEntries.set(scopedKey, entry);
        const limits = limitForKey(scopedKey, { maxEntries, maxBytes, policyName });
        let persisted = false;
        let persistenceError = null;
        try {
            const result = await runTransaction("readwrite", (store) => store.put(entry));
            persisted = result !== undefined;
            if (!persisted) persistenceError = new Error("IndexedDB is unavailable; data is memory-only.");
        } catch (error) {
            console.warn(`Unable to persist client cache entry ${scopedKey}`, error);
            persistenceError = error;
        }
        const memoryEntry = { ...entry, persisted };
        memoryEntries.set(scopedKey, memoryEntry);
        try {
            await prunePrivateEntries(scopedKey, limits);
        } catch (error) {
            console.warn(`Unable to enforce client cache limits for ${scopedKey}`, error);
        }
        return {
            ...memoryEntry,
            isFresh: true,
            persisted,
            persistenceError,
        };
    }

    async function removePrefix(prefix) {
        const scopedPrefix = assertScopedKey(uid, prefix);
        [...memoryEntries.keys()]
            .filter((key) => key.startsWith(scopedPrefix))
            .forEach((key) => memoryEntries.delete(key));
        try {
            const database = await openDatabase();
            if (!database) return;
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(ENTRY_STORE, "readwrite");
                const store = transaction.objectStore(ENTRY_STORE);
                const cursor = store.openCursor();
                cursor.onsuccess = () => {
                    const current = cursor.result;
                    if (!current) return;
                    if (current.key.startsWith(scopedPrefix) && current.value?.uid === uid) current.delete();
                    current.continue();
                };
                cursor.onerror = () => reject(cursor.error);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            console.warn(`Unable to remove client cache prefix ${scopedPrefix}`, error);
        }
    }

    async function clearUser() {
        [...memoryEntries.entries()]
            .filter(([, entry]) => entry.uid === uid)
            .forEach(([key]) => memoryEntries.delete(key));
        try {
            const database = await openDatabase();
            if (!database) return;
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(ENTRY_STORE, "readwrite");
                const index = transaction.objectStore(ENTRY_STORE).index("uid");
                const cursor = index.openCursor(IDBKeyRange.only(uid));
                cursor.onsuccess = () => {
                    const current = cursor.result;
                    if (!current) return;
                    current.delete();
                    current.continue();
                };
                cursor.onerror = () => reject(cursor.error);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            console.warn(`Unable to clear client cache for the active user`, error);
            throw error;
        }
    }

    return Object.freeze({ uid, keys, get, set, remove, removePrefix, clearUser });
}

function createUserCacheChannel(rawUid, onMessage = () => {}, {
    BroadcastChannelImpl = globalThis.BroadcastChannel,
    storage = globalThis.localStorage,
    eventTarget = globalThis,
    now = () => Date.now(),
} = {}) {
    const uid = assertUid(rawUid);
    const channel = typeof BroadcastChannelImpl === "function"
        ? new BroadcastChannelImpl(CACHE_CHANNEL_NAME)
        : null;

    function normalizeMessage(value) {
        if (!value || typeof value !== "object") return null;
        if (value.schemaVersion !== ENVELOPE_SCHEMA_VERSION) return null;
        if (value.uid !== uid || !CACHE_MESSAGE_TYPES.has(value.type)) return null;
        if (!Number.isFinite(value.createdAt) || typeof value.messageId !== "string") return null;
        return {
            schemaVersion: value.schemaVersion,
            messageId: value.messageId,
            type: value.type,
            uid: value.uid,
            entityId: typeof value.entityId === "string" ? value.entityId : null,
            operation: typeof value.operation === "string" ? value.operation : "updated",
            version: ["string", "number"].includes(typeof value.version) ? value.version : null,
            createdAt: value.createdAt,
        };
    }

    function receive(value) {
        const message = normalizeMessage(value);
        if (message) onMessage(message);
    }

    function onStorage(event) {
        if (event.key !== CACHE_STORAGE_EVENT_KEY || !event.newValue) return;
        try { receive(JSON.parse(event.newValue)); } catch { /* Ignore malformed fallback messages. */ }
    }

    if (channel) channel.addEventListener("message", (event) => receive(event.data));
    else eventTarget?.addEventListener?.("storage", onStorage);

    function publish(type, {
        entityId = null,
        operation = "updated",
        version = null,
    } = {}) {
        if (!CACHE_MESSAGE_TYPES.has(type)) throw new TypeError(`Unsupported cache message type: ${type}`);
        const createdAt = now();
        const message = {
            schemaVersion: ENVELOPE_SCHEMA_VERSION,
            messageId: `${uid}:${createdAt}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
            type,
            uid,
            entityId: entityId === null ? null : String(entityId),
            operation: String(operation || "updated"),
            version: ["string", "number"].includes(typeof version) ? version : null,
            createdAt,
        };
        if (channel) {
            channel.postMessage(message);
        } else if (storage) {
            try {
                storage.setItem(CACHE_STORAGE_EVENT_KEY, JSON.stringify(message));
                storage.removeItem(CACHE_STORAGE_EVENT_KEY);
            } catch (error) {
                console.warn("Unable to publish cache update through the storage fallback", error);
            }
        }
        return message;
    }

    function close() {
        channel?.close();
        if (!channel) eventTarget?.removeEventListener?.("storage", onStorage);
    }

    return Object.freeze({ uid, publish, close });
}

async function clearPrivateUserData(rawUid, {
    storage = globalThis.localStorage,
} = {}) {
    const uid = assertUid(rawUid);
    const channel = createUserCacheChannel(uid);
    try {
        channel.publish("signed-out", { operation: "logout" });
        const failures = [];
        try {
            await createUserDataStore(uid).clearUser();
        } catch (error) {
            failures.push(error);
        }
        try {
            storage?.removeItem(`dcf_dip_finder_watchlist_v1:${uid}`);
        } catch (error) {
            console.warn("Unable to clear user-scoped browser preferences", error);
            failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Private browser data cleanup failed");
    } finally {
        channel.close();
    }
}

export {
    CACHE_STALE_TTL,
    CACHE_TTL,
    ENVELOPE_SCHEMA_VERSION,
    createDipPerformanceResultKey,
    createUserCacheChannel,
    createUserDataStore,
    clearPrivateUserData,
};
