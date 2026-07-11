import { CACHE_POLICIES } from "./cache-policy.js";
import { createUserDataStore } from "./data-store.js";
import { deletePublicRecord, getPublicEntry, setPublicRecord } from "./public-data-store.js";

function getPolicy(name) {
    const policy = CACHE_POLICIES[name];
    if (!policy) throw new TypeError(`Unknown cache policy: ${name}`);
    return policy;
}

function normaliseRevalidationResult(value) {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "data")) return value;
    return { data: value };
}

function createCacheRegistry({ uid = null } = {}) {
    const userStore = uid ? createUserDataStore(uid) : null;

    function key(name, params = {}) {
        const policy = getPolicy(name);
        if (typeof policy.key !== "function") {
            throw new TypeError(`${name} requires its existing UID-scoped data-store key.`);
        }
        return policy.key(params);
    }

    function privateStore(name) {
        const policy = getPolicy(name);
        if (policy.ownership !== "uid") throw new TypeError(`${name} is a public cache policy.`);
        if (!userStore) throw new TypeError(`${name} requires a Firebase UID.`);
        return userStore;
    }

    async function get(name, cacheKey, { allowStale = true } = {}) {
        const policy = getPolicy(name);
        if (policy.ownership === "public") {
            const entry = await getPublicEntry(cacheKey, { allowExpired: allowStale });
            return entry ? { ...entry, policy } : null;
        }
        const entry = await privateStore(name).get(cacheKey, { allowExpired: allowStale });
        return entry ? { ...entry, policy } : null;
    }

    async function set(name, cacheKey, data, { version = null, serverUpdatedAt = null } = {}) {
        const policy = getPolicy(name);
        if (policy.ownership === "public") {
            const entry = await setPublicRecord(cacheKey, data, policy.ttlMs, {
                staleTtlMs: policy.staleTtlMs,
                version: version ?? policy.version,
                serverUpdatedAt,
            });
            return entry ? { ...entry, policy, isFresh: true } : null;
        }
        const entry = await privateStore(name).set(cacheKey, data, {
            ttlMs: policy.ttlMs,
            staleTtlMs: policy.staleTtlMs,
            version: version ?? policy.version,
            serverUpdatedAt,
        });
        return { ...entry, policy };
    }

    async function mutate(name, cacheKey, update, options = {}) {
        if (typeof update !== "function") throw new TypeError("Cache mutations require an update function.");
        const entry = await get(name, cacheKey, { allowStale: true });
        return set(name, cacheKey, await update(entry?.data ?? null, entry), options);
    }

    async function invalidate(name, cacheKey) {
        if (getPolicy(name).ownership === "public") return deletePublicRecord(cacheKey);
        return privateStore(name).remove(cacheKey);
    }

    async function revalidate(name, cacheKey, loader, options = {}) {
        if (typeof loader !== "function") throw new TypeError("Cache revalidation requires a loader function.");
        const existing = await get(name, cacheKey, { allowStale: true });
        const result = normaliseRevalidationResult(await loader(existing?.data ?? null, existing));
        return set(name, cacheKey, result.data, {
            ...options,
            version: result.version ?? options.version ?? existing?.version ?? null,
            serverUpdatedAt: result.serverUpdatedAt ?? options.serverUpdatedAt ?? null,
        });
    }

    async function clearUser() {
        if (userStore) await userStore.clearUser();
    }

    return Object.freeze({ uid: userStore?.uid ?? null, policies: CACHE_POLICIES, key, get, set, mutate, invalidate, revalidate, clearUser });
}

export { CACHE_POLICIES, createCacheRegistry };
