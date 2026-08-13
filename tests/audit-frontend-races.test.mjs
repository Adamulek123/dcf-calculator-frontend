import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import { CACHE_TTL, createUserDataStore } from "../js/data-store.js";

async function importPortfolioBootstrapOrchestrator() {
    const firebaseAppUrl = "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
    const firebaseAuthUrl = "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
    const asModuleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
    const appModuleUrl = asModuleUrl(`
        export const initializeApp = (config) => ({ config });
    `);
    const authModuleUrl = asModuleUrl(`
        export const getAuth = () => ({ currentUser: null, emulatorConfig: null });
        export const connectAuthEmulator = () => {};
        export const signInWithEmailAndPassword = async () => ({ user: {} });
        export const createUserWithEmailAndPassword = async () => ({ user: {} });
        export const sendEmailVerification = async () => {};
        export const signOut = async () => {};
        export const onAuthStateChanged = () => () => {};
        export class GoogleAuthProvider {}
        export const signInWithPopup = async () => ({ user: {} });
    `);
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === firebaseAppUrl) return { url: appModuleUrl, shortCircuit: true };
            if (specifier === firebaseAuthUrl) return { url: authModuleUrl, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { hostname: "test.invalid" } },
        writable: true,
    });
    delete globalThis.document;
    try {
        const moduleUrl = new URL("../js/portfolio-creator.js", import.meta.url);
        moduleUrl.searchParams.set("orchestration-test", `${Date.now()}-${Math.random()}`);
        return await import(moduleUrl.href);
    } finally {
        hooks.deregister();
        if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
        else delete globalThis.window;
        if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
        else delete globalThis.document;
    }
}

class FakeRequest {
    constructor(result = undefined) {
        this.result = result;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}

class FakeStore {
    constructor(transaction) {
        this.transaction = transaction;
        this.indexNames = { contains: () => false };
    }

    createIndex() {}

    put(value) {
        const request = new FakeRequest(value.key);
        this.transaction.schedule(request, () => this.transaction.database.entries.set(value.key, value));
        return request;
    }

    delete(key) {
        const request = new FakeRequest(undefined);
        this.transaction.schedule(request, () => this.transaction.database.entries.delete(key));
        return request;
    }
}

class FakeTransaction {
    constructor(database) {
        this.database = database;
        this.error = null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this.shouldFail = database.failNextTransaction;
        database.failNextTransaction = false;
        this.store = new FakeStore(this);
    }

    objectStore() {
        return this.store;
    }

    schedule(request, operation) {
        queueMicrotask(() => {
            if (this.shouldFail) {
                this.error = new Error("synthetic IndexedDB failure");
                request.error = this.error;
                request.onerror?.({ target: request });
                this.onerror?.({ target: this });
                return;
            }
            operation();
            request.onsuccess?.({ target: request });
            queueMicrotask(() => this.oncomplete?.({ target: this }));
        });
    }
}

class FakeDatabase {
    constructor() {
        this.entries = new Map();
        this.failNextTransaction = false;
        this.objectStoreNames = { contains: () => true };
    }

    createObjectStore() {
        return new FakeStore({ database: this });
    }

    transaction() {
        return new FakeTransaction(this);
    }
}

function installFakeIndexedDb(database) {
    globalThis.indexedDB = {
        open() {
            const request = new FakeRequest(database);
            setTimeout(() => request.onsuccess?.({ target: request }), 0);
            return request;
        },
    };
}

test("IndexedDB delete reports durable completion even when delete result is undefined", async () => {
    const database = new FakeDatabase();
    installFakeIndexedDb(database);
    const store = createUserDataStore(`idb-delete-${Date.now()}-${Math.random()}`);
    const key = store.keys.portfolioOutbox("race");

    const saved = await store.set(key, { mutationId: "one" }, {
        ttlMs: CACHE_TTL.portfolioOutbox,
        staleTtlMs: 0,
    });
    assert.equal(saved.persisted, true);

    const removed = await store.remove(key);
    assert.equal(removed.persisted, true);
    assert.equal(removed.key, key);

    database.failNextTransaction = true;
    const failed = await store.remove(key);
    assert.equal(failed.persisted, false);
    assert.equal(failed.error?.message, "synthetic IndexedDB failure");

    delete globalThis.indexedDB;
});

function createOutboxSaveHarness({ persist, request, createId, restoredSnapshot = null }) {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const restoredRequest = restoredSnapshot?.request || null;
    let revision = Number(restoredSnapshot?.clientRevision) || 0;
    let savedRevision = 0;
    let serverRevision = restoredRequest?.baseRevision ?? "R0";
    let pendingMutationId = restoredRequest?.idempotencyKey || null;
    let pendingPersistence = Promise.resolve(true);
    let savePromise = null;
    let value = restoredRequest?.positions?.[0]?.value || "";
    let durableOutbox = restoredSnapshot ? clone(restoredSnapshot) : null;

    function createRequest(mutationId) {
        return Object.freeze({
            portfolioId: "portfolio-one",
            positions: Object.freeze([Object.freeze({ ticker: "TEST", value })]),
            baseCurrency: "USD",
            baseRevision: serverRevision,
            idempotencyKey: mutationId,
        });
    }

    function createSnapshot(requestPayload) {
        return Object.freeze({
            portfolioId: requestPayload.portfolioId,
            positions: requestPayload.positions,
            baseCurrency: requestPayload.baseCurrency,
            baseRevision: requestPayload.baseRevision,
            clientRevision: revision,
            mutationId: requestPayload.idempotencyKey,
            request: requestPayload,
            savedAt: "test-time",
        });
    }

    function queueSnapshot(snapshot) {
        pendingPersistence = pendingPersistence
            .catch(() => false)
            .then(async () => {
                const persisted = await persist(snapshot);
                if (persisted) durableOutbox = clone(snapshot);
                return persisted;
            });
        return pendingPersistence;
    }

    function edit(nextValue) {
        value = nextValue;
        revision += 1;
        pendingMutationId = createId();
        void queueSnapshot(createSnapshot(createRequest(pendingMutationId)));
    }

    async function save() {
        if (savePromise) return savePromise;
        const targetRevision = revision;
        const mutationId = pendingMutationId || createId();
        if (!pendingMutationId) pendingMutationId = mutationId;
        const requestPayload = createRequest(mutationId);
        // Mirrors production: the precise immutable network body is serialized
        // after any edit-time snapshot and awaited immediately before sending.
        const targetPersistence = queueSnapshot(createSnapshot(requestPayload));
        savePromise = (async () => {
            try {
                assert.equal(await targetPersistence, true);
                const response = await request(requestPayload, clone(durableOutbox));
                if (response.ok) {
                    savedRevision = Math.max(savedRevision, targetRevision);
                    serverRevision = response.revision ?? serverRevision;
                    if (pendingMutationId === mutationId) pendingMutationId = null;
                }
                return response.ok;
            } catch {
                return false;
            }
        })().finally(() => { savePromise = null; });
        return savePromise;
    }

    return {
        edit,
        save,
        getOutbox: () => clone(durableOutbox),
        getState: () => ({ revision, savedRevision, serverRevision, pendingMutationId }),
    };
}

test("portfolio replay preserves B's exact post-A request after B's response is lost", async () => {
    const persistenceHistory = [];
    const requests = [];
    let resolveFirstRequest;
    let idNumber = 0;
    const harness = createOutboxSaveHarness({
        createId: () => `mutation-${++idNumber}`,
        persist: async (snapshot) => {
            persistenceHistory.push(JSON.parse(JSON.stringify(snapshot)));
            return true;
        },
        request: (payload, durableSnapshot) => {
            requests.push(JSON.parse(JSON.stringify(payload)));
            assert.deepEqual(durableSnapshot.request, payload);
            if (requests.length === 1) {
                return new Promise((resolve) => { resolveFirstRequest = resolve; });
            }
            return Promise.reject(new Error("response lost after server accepted B"));
        },
    });

    harness.edit("A");
    const firstSave = harness.save();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests[0].baseRevision, "R0");
    assert.equal(requests[0].idempotencyKey, "mutation-1");

    harness.edit("B");
    resolveFirstRequest({ ok: true, revision: "R1" });
    await firstSave;
    assert.equal(harness.getState().pendingMutationId, "mutation-2");
    assert.equal(harness.getState().serverRevision, "R1");

    const secondSave = harness.save();
    assert.equal(await secondSave, false);
    const lostRequest = requests[1];
    const lostSnapshot = harness.getOutbox();
    assert.equal(lostRequest.baseRevision, "R1");
    assert.equal(lostRequest.idempotencyKey, "mutation-2");
    assert.equal(lostRequest.positions[0].value, "B");
    assert.deepEqual(lostSnapshot.request, lostRequest);
    assert.equal(lostSnapshot.mutationId, "mutation-2");
    assert.equal(persistenceHistory.at(-1).baseRevision, "R1");
    assert.deepEqual(
        persistenceHistory.map((snapshot) => [
            snapshot.mutationId,
            snapshot.baseRevision,
            snapshot.request.positions[0].value,
        ]),
        [
            ["mutation-1", "R0", "A"],
            ["mutation-1", "R0", "A"],
            ["mutation-2", "R0", "B"],
            ["mutation-2", "R1", "B"],
        ],
    );

    const replayRequests = [];
    const replayHarness = createOutboxSaveHarness({
        restoredSnapshot: lostSnapshot,
        createId: () => `unexpected-${++idNumber}`,
        persist: async () => true,
        request: async (payload, durableSnapshot) => {
            replayRequests.push(JSON.parse(JSON.stringify(payload)));
            assert.deepEqual(durableSnapshot.request, payload);
            return { ok: true, revision: "R2" };
        },
    });
    assert.equal(await replayHarness.save(), true);
    assert.deepEqual(replayRequests[0], lostRequest);
    assert.equal(JSON.stringify(replayRequests[0]), JSON.stringify(lostRequest));
    assert.equal(replayHarness.getState().pendingMutationId, null);
});

test("portfolio bootstrap hydrates active detail and awaits matching durable outbox replay", async () => {
    const { orchestrateBootstrapActiveDetail } = await importPortfolioBootstrapOrchestrator();
    const events = [];
    const durableOutbox = {
        uid: "user-one",
        portfolioId: "portfolio-new",
        request: {
            portfolioId: "portfolio-new",
            positions: [{ ticker: "MSFT", value: "pending-B" }],
            baseCurrency: "USD",
            baseRevision: "R1",
            idempotencyKey: "mutation-B",
        },
    };
    let loadState = "loading";
    let replayedRequest = null;
    let releaseRestore;
    const restoreBarrier = new Promise((resolve) => { releaseRestore = resolve; });

    const bootstrap200 = orchestrateBootstrapActiveDetail({
        responseStatus: 200,
        hasCachedIndex: true,
        activePortfolioId: "portfolio-new",
        activeDetail: {
            portfolioId: "portfolio-new",
            positions: [{ ticker: "AAPL", value: "server" }],
            baseCurrency: "USD",
            revision: "R1",
        },
        canApply: () => true,
        loadPortfolio: async () => assert.fail("bootstrap detail should avoid a second network load"),
        loadCachedDetail: async (portfolioId) => {
            events.push(`read-detail:${portfolioId}`);
            return null;
        },
        persistDetail: (detail, cachedDetail) => {
            assert.equal(cachedDetail, null);
            events.push(`persist-detail:${detail.portfolioId}`);
        },
        hydrateDetail: async (detail) => {
            assert.equal(detail.portfolioId, durableOutbox.portfolioId);
            loadState = "ready";
            events.push(`hydrate-detail:${detail.portfolioId}`);
            await restoreBarrier;
            assert.equal(durableOutbox.uid, "user-one");
            assert.equal(durableOutbox.portfolioId, detail.portfolioId);
            replayedRequest = structuredClone(durableOutbox.request);
            events.push(`restore-outbox:${detail.portfolioId}`);
            return true;
        },
    });
    let bootstrapSettled = false;
    void bootstrap200.then(() => { bootstrapSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loadState, "ready", "canonical detail is hydrated before outbox I/O completes");
    assert.equal(bootstrapSettled, false, "bootstrap must await durable outbox restoration");
    releaseRestore();
    assert.equal(await bootstrap200, true);
    assert.deepEqual(replayedRequest, durableOutbox.request);
    assert.deepEqual(events, [
        "read-detail:portfolio-new",
        "persist-detail:portfolio-new",
        "hydrate-detail:portfolio-new",
        "restore-outbox:portfolio-new",
    ]);

    // A stale-but-version-valid index receives 304. It must still enter the
    // canonical detail loader, which performs detail hydration and replay.
    loadState = "loading";
    replayedRequest = null;
    const bootstrap304 = await orchestrateBootstrapActiveDetail({
        responseStatus: 304,
        hasCachedIndex: true,
        activePortfolioId: "portfolio-new",
        canApply: () => true,
        loadPortfolio: async (portfolioId) => {
            events.push(`load-detail:${portfolioId}`);
            loadState = "ready";
            await Promise.resolve();
            replayedRequest = structuredClone(durableOutbox.request);
            events.push(`restore-after-304:${portfolioId}`);
            return true;
        },
        hydrateDetail: async () => assert.fail("304 must route through loadPortfolio"),
    });
    assert.equal(bootstrap304, true);
    assert.equal(loadState, "ready");
    assert.deepEqual(replayedRequest, durableOutbox.request);
    assert.deepEqual(events.slice(-2), [
        "load-detail:portfolio-new",
        "restore-after-304:portfolio-new",
    ]);

    let currentUid = "user-one";
    let releaseCachedRead;
    let hydratedWrongUser = false;
    const cachedReadBarrier = new Promise((resolve) => { releaseCachedRead = resolve; });
    const supersededBootstrap = orchestrateBootstrapActiveDetail({
        responseStatus: 200,
        hasCachedIndex: true,
        activePortfolioId: "portfolio-new",
        activeDetail: { portfolioId: "portfolio-new" },
        canApply: () => currentUid === "user-one",
        loadPortfolio: async () => assert.fail("matching detail should not fall back to loadPortfolio"),
        loadCachedDetail: async () => {
            await cachedReadBarrier;
            return null;
        },
        hydrateDetail: async () => { hydratedWrongUser = true; },
    });
    currentUid = "user-two";
    releaseCachedRead();
    assert.equal(await supersededBootstrap, true);
    assert.equal(hydratedWrongUser, false, "a superseded UID must not hydrate or restore");
});

function createComboboxHarness(symbols) {
    let value = "";
    let active = -1;
    let open = true;
    const searches = [];

    function keydown(key) {
        if (key === "ArrowDown" && open) active = (active + 1) % symbols.length;
        else if (key === "ArrowUp" && open) {
            active = active < 0 ? symbols.length - 1 : (active - 1 + symbols.length) % symbols.length;
        } else if (key === "Escape") { active = -1; open = false; }
        else if (key === "Enter" && open && active >= 0) {
            value = symbols[active];
            active = -1;
            open = false;
            searches.push(value);
        } else if (key === "Enter") {
            open = false;
            searches.push(value);
        }
        return { value, active, open };
    }

    return { keydown, setValue: (next) => { value = next; }, searches };
}

test("DCF combobox keyboard behavior selects an active option and preserves plain Enter search", () => {
    const reverseCombobox = createComboboxHarness(["AAPL", "AMZN", "AVGO"]);
    assert.equal(reverseCombobox.keydown("ArrowUp").active, 2);
    assert.equal(reverseCombobox.keydown("Enter").value, "AVGO");

    const combobox = createComboboxHarness(["AAPL", "AMZN"]);
    assert.equal(combobox.keydown("ArrowDown").active, 0);
    assert.equal(combobox.keydown("ArrowDown").active, 1);
    assert.equal(combobox.keydown("Enter").value, "AMZN");
    assert.deepEqual(combobox.searches, ["AMZN"]);

    combobox.setValue("MSFT");
    assert.equal(combobox.keydown("Escape").open, false);
    assert.equal(combobox.keydown("Enter").value, "MSFT");
    assert.deepEqual(combobox.searches, ["AMZN", "MSFT"]);
});

test("service-worker shell precaches both authentication page entry modules", () => {
    const serviceWorker = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
    for (const moduleName of ["login-page.js", "register-page.js"]) {
        assert.match(serviceWorker, new RegExp(`\\./js/${moduleName.replace(".", "\\.")}`));
        assert.equal(existsSync(new URL(`../js/${moduleName}`, import.meta.url)), true);
    }
});

test("shared stylesheet revisions stay aligned with the service-worker cache", () => {
    const serviceWorker = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
    const stylesheetRevision = serviceWorker.match(/\.\/css\/style\.css\?v=(\d+)/)?.[1];

    assert.ok(stylesheetRevision, "service worker must precache a versioned shared stylesheet");
    assert.match(serviceWorker, /dcf-shell-v\d+/);
    assert.match(serviceWorker, /url\.pathname\}\$\{url\.search\}/);

    for (const pageName of [
        "index.html",
        "login.html",
        "register.html",
        "dcf-calculator.html",
        "portfolio-creator.html",
        "dip-finder.html",
        "financial-data.html",
        "earnings-calendar.html",
    ]) {
        const page = readFileSync(new URL(`../${pageName}`, import.meta.url), "utf8");
        assert.match(page, new RegExp(`css/style\\.css\\?v=${stylesheetRevision}`));
    }
});
