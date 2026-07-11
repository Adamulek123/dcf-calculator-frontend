const DATABASE_NAME = "dcf-client-data";
const DATABASE_VERSION = 1;
const ENTRY_STORE = "entries";
const ENVELOPE_SCHEMA_VERSION = 1;
const CACHE_CHANNEL_NAME = "dcf-data-updates-v1";
const CACHE_STORAGE_EVENT_KEY = "dcf_data_update_signal_v1";
const CACHE_MESSAGE_TYPES = new Set(["portfolio-updated", "watchlist-updated", "signed-out"]);

const CACHE_TTL = Object.freeze({
    portfolioIndex: 10 * 60 * 1000,
    portfolioDetail: 10 * 60 * 1000,
    watchlists: 10 * 60 * 1000,
    dipPerformance: 5 * 60 * 1000,
    fxRates: 6 * 60 * 60 * 1000,
});

const memoryEntries = new Map();
let databasePromise;

function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!globalThis.indexedDB) {
        databasePromise = Promise.resolve(null);
        return databasePromise;
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
    if (!normalized.includes(`:${uid}`)) {
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
    });
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

    async function remove(key) {
        const scopedKey = assertScopedKey(uid, key);
        memoryEntries.delete(scopedKey);
        try {
            await runTransaction("readwrite", (store) => store.delete(scopedKey));
        } catch (error) {
            console.warn(`Unable to remove client cache entry ${scopedKey}`, error);
        }
    }

    async function get(key, { allowExpired = true } = {}) {
        const scopedKey = assertScopedKey(uid, key);
        let entry = memoryEntries.get(scopedKey);
        if (!entry) {
            try {
                const database = await openDatabase();
                if (database) {
                    const transaction = database.transaction(ENTRY_STORE, "readonly");
                    entry = await requestResult(transaction.objectStore(ENTRY_STORE).get(scopedKey));
                }
            } catch (error) {
                console.warn(`Unable to read client cache entry ${scopedKey}`, error);
            }
        }

        if (!validEnvelope(entry, uid, scopedKey)) {
            if (entry) await remove(scopedKey);
            return null;
        }
        memoryEntries.set(scopedKey, entry);
        const isFresh = entry.expiresAt > now();
        if (!allowExpired && !isFresh) return null;
        return { ...entry, isFresh };
    }

    async function set(key, data, {
        ttlMs,
        serverUpdatedAt = null,
        version = null,
    } = {}) {
        const scopedKey = assertScopedKey(uid, key);
        if (!Number.isFinite(ttlMs) || ttlMs < 0) {
            throw new TypeError("Client cache entries require a non-negative ttlMs.");
        }
        const cachedAt = now();
        const entry = {
            key: scopedKey,
            schemaVersion: ENVELOPE_SCHEMA_VERSION,
            uid,
            cachedAt,
            expiresAt: cachedAt + ttlMs,
            serverUpdatedAt,
            version,
            data,
        };
        memoryEntries.set(scopedKey, entry);
        try {
            await runTransaction("readwrite", (store) => store.put(entry));
        } catch (error) {
            console.warn(`Unable to persist client cache entry ${scopedKey}`, error);
        }
        return { ...entry, isFresh: true };
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

export {
    CACHE_TTL,
    ENVELOPE_SCHEMA_VERSION,
    createDipPerformanceResultKey,
    createUserCacheChannel,
    createUserDataStore,
};
