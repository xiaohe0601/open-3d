import { holdTemporaryScope } from "../src/modra/storage/temporary-scope-lock";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { IndexedDBModraRepository, MODRA_LEASE_MS } from "../src/modra/storage/indexeddb-repository";
import type { SessionRecord } from "../src/modra/storage/indexeddb-repository";
import { DurableSessionOwner } from "../src/modra/storage/session-owner";
import {
  createMemorySessionRepository,
  createModraSession,
  ModraRuntime,
  type ProviderRequest,
} from "@open-3d/ai/runtime";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { createProcessor } from "../src/workspace/modeling";

let name: string;
let now: number;
let repositories: IndexedDBModraRepository[];
let owners: DurableSessionOwner[];
function sessionOwner(repo: IndexedDBModraRepository, record: SessionRecord, onLost: () => void = vi.fn()) {
  const owner = new DurableSessionOwner(repo, record.id, record.scopeId, onLost);
  owners.push(owner);
  return owner;
}
function repository(ownerId: string) {
  const repo = new IndexedDBModraRepository({ name, ownerId, now: () => now, notifications: false });
  repositories.push(repo);
  return repo;
}
const image = (id: string) => ({
  assetId: id,
  name: "reference.png",
  mediaType: "image/png",
  byteLength: 3,
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});
function withImages(record: SessionRecord, ids: string[]) {
  return {
    ...record.state,
    lastSequence: 1,
    messages: [
      {
        id: "message",
        taskId: "task",
        runId: "run",
        base: { generationId: "generation", scopeId: record.scopeId, mutationVersion: 0 },
        role: "user" as const,
        text: "Use these references",
        assets: ids.map((id) => {
          const { blob: _blob, ...reference } = image(id);
          return reference;
        }),
        toolCalls: [],
      },
    ],
  };
}
beforeEach(() => {
  name = `modra-test-${crypto.randomUUID()}`;
  now = 1000;
  repositories = [];
  owners = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(owners.map((owner) => owner.close()));
  vi.useRealTimers();
  await Promise.all(repositories.map((repo) => repo.close()));
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error);
  });
});

test("persists message references and Blob assets atomically and reopens without dispatch", async () => {
  const first = repository("first");
  const record = await first.create("project:one");
  const owner = await first.acquire(record.id, record.scopeId);
  first.stageAsset(image("reference"));
  const state = withImages(record, ["reference"]);
  await first.save(state, owner);
  await first.saveDraft({ text: "Draft", assets: state.messages[0].assets }, owner);
  await first.release(owner);
  const reopened = repository("second");
  expect(await reopened.list("project:two")).toEqual([]);
  const loaded = await reopened.load(record.id);
  expect(loaded?.state).toEqual(state);
  expect(loaded?.draft.text).toBe("Draft");
  const stored = await reopened.asset("reference");
  expect(stored?.blob).toBeInstanceOf(Blob);
  expect(Array.from(new Uint8Array(await stored!.blob.arrayBuffer()))).toEqual([1, 2, 3]);
});

test("missing asset aborts the whole transaction, leaving no dangling or partially added assets", async () => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const owner = await repo.acquire(record.id, record.scopeId);
  repo.stageAsset(image("first"));
  await expect(repo.save(withImages(record, ["first", "missing"]), owner)).rejects.toMatchObject({ code: "missing" });
  const reader = repository("reader");
  expect((await reader.load(record.id))?.state.messages).toEqual([]);
  expect(await reader.asset("first")).toBeNull();
  expect(await reader.asset("missing")).toBeNull();
});

test("quota failure after staging a Blob rolls back all durable changes and keeps active assets", async () => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const owner = await repo.acquire(record.id, record.scopeId);
  repo.stageAsset(image("reference"));
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "sessions") throw new DOMException("full", "QuotaExceededError");
    return put.call(this, value, key);
  });
  await expect(repo.save(withImages(record, ["reference"]), owner)).rejects.toMatchObject({ code: "quota" });
  spy.mockRestore();
  expect(await repo.asset("reference")).not.toBeNull();
  const reader = repository("reader");
  expect(await reader.asset("reference")).toBeNull();
  expect((await reader.load(record.id))?.state.messages).toEqual([]);
});

test("live ownership denies another client and concurrent writes reject a stale revision", async () => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.create("project:one");
  const owner = await first.acquire(record.id, record.scopeId);
  expect((await second.load(record.id))?.state.messages).toEqual([]);
  await expect(second.acquire(record.id, record.scopeId)).rejects.toMatchObject({ code: "owned" });
  const outcomes = await Promise.allSettled([
    first.saveDraft({ text: "first", assets: [] }, owner),
    first.saveDraft({ text: "stale", assets: [] }, owner),
  ]);
  expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  expect((await first.load(record.id))?.draft.text).toBe("first");
});

test("expired takeover increments the fence and rejects the old client's write, tool and renewal", async () => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.create("project:one");
  const old = await first.acquire(record.id, record.scopeId);
  now += MODRA_LEASE_MS;
  expect(first.isWritable(old)).toBe(false);
  const fresh = await second.acquire(record.id, record.scopeId);
  expect(fresh.epoch).toBeGreaterThan(old.epoch);
  await expect(first.save(record.state, old)).rejects.toMatchObject({ code: "owned" });
  const tool = vi.fn();
  await expect(first.guarded(old, tool)).rejects.toMatchObject({ code: "owned" });
  expect(tool).not.toHaveBeenCalled();
  await expect(first.renew(old)).rejects.toMatchObject({ code: "owned" });
  await second.saveDraft({ text: "Fresh", assets: [] }, fresh);
});

test("renewal extends only a live owner and cannot revive an expired suspended client", async () => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const owner = await repo.acquire(record.id, record.scopeId);
  const firstExpiry = owner.expiresAt;
  now += 10_000;
  await repo.renew(owner);
  expect(owner.expiresAt).toBe(firstExpiry + 10_000);
  now = owner.expiresAt;
  await expect(repo.renew(owner)).rejects.toMatchObject({ code: "owned" });
  const recovered = await repo.acquire(record.id, record.scopeId);
  expect(recovered.epoch).toBeGreaterThan(owner.epoch);
});

test.each(["scope", "session"] as const)("%s tombstones block old writes and resurrection", async (kind) => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.create("project:one");
  const owner = await first.acquire(record.id, record.scopeId);
  await second.seal(kind, kind === "scope" ? record.scopeId : record.id);
  const commit = vi.fn();
  await expect(first.guarded(owner, commit)).rejects.toMatchObject({ code: "fenced" });
  expect(commit).not.toHaveBeenCalled();
  await expect(first.save(record.state, owner)).rejects.toMatchObject({ code: "fenced" });
  await expect(second.acquire(record.id, record.scopeId)).rejects.toMatchObject({ code: "fenced" });
  await expect(
    second.create(record.scopeId, "New", kind === "session" ? record.id : crypto.randomUUID()),
  ).rejects.toMatchObject({ code: "fenced" });
  expect((await second.load(record.id))?.state).toEqual(record.state);
  expect((await second.create("project:unrelated")).scopeId).toBe("project:unrelated");
});

test("cleanup retains assets referenced by another session or draft and is retryable", async () => {
  const repo = repository("writer");
  const first = await repo.create("project:one");
  const second = await repo.create("project:two");
  const firstOwner = await repo.acquire(first.id, first.scopeId);
  const secondOwner = await repo.acquire(second.id, second.scopeId);
  repo.stageAsset(image("shared"));
  repo.stageAsset(image("only-first"));
  await repo.save(withImages(first, ["shared", "only-first"]), firstOwner);
  await repo.saveDraft(
    { text: "Keep reference", assets: withImages(second, ["shared"]).messages[0].assets },
    secondOwner,
  );
  const seal = await repo.seal("scope", first.scopeId);
  await repo.cleanup(seal);
  await repo.cleanup(seal);
  const reader = repository("reader");
  expect(await reader.load(first.id)).toBeNull();
  expect(await reader.asset("only-first")).toBeNull();
  expect(await reader.asset("shared")).not.toBeNull();
  await repo.saveDraft({ text: "", assets: [] }, secondOwner);
  await repo.collect(secondOwner);
  expect(await reader.asset("shared")).toBeNull();
  await expect(repo.create(first.scopeId)).rejects.toMatchObject({ code: "fenced" });
});

test("stale owners cannot garbage collect assets and corrupt references abort reclamation", async () => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.create("project:one");
  const old = await first.acquire(record.id, record.scopeId);
  first.stageAsset(image("reference"));
  await first.save(withImages(record, ["reference"]), old);
  now += MODRA_LEASE_MS;
  const fresh = await second.acquire(record.id, record.scopeId);
  await expect(first.collect(old)).rejects.toMatchObject({ code: "owned" });
  expect(await second.asset("reference")).not.toBeNull();
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    return put.call(this, this.name === "sessions" ? { ...value, schemaVersion: 50 } : value, key);
  });
  await second.rename("Future record", fresh);
  spy.mockRestore();
  await expect(second.collect(fresh)).rejects.toMatchObject({ code: "newer-version" });
  expect(await second.asset("reference")).not.toBeNull();
});

test("a closed repository cannot regain ownership or save through a delayed callback", async () => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const owner = await repo.acquire(record.id, record.scopeId);
  await repo.close();
  expect(repo.isWritable(owner)).toBe(false);
  await expect(repo.save(record.state, owner)).rejects.toMatchObject({ code: "unavailable" });
  await expect(repo.acquire(record.id, record.scopeId)).rejects.toMatchObject({ code: "unavailable" });
});

test("late release, failed check and failed renewal cannot erase a newer local acquisition", async () => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const old = await repo.acquire(record.id, record.scopeId);
  now += MODRA_LEASE_MS;
  const fresh = await repo.acquire(record.id, record.scopeId);
  await repo.release(old);
  expect(repo.isWritable(fresh)).toBe(true);
  await expect(repo.assertWritable(old)).rejects.toMatchObject({ code: "owned" });
  expect(repo.isWritable(fresh)).toBe(true);
  await expect(repo.renew(old)).rejects.toMatchObject({ code: "owned" });
  expect(repo.isWritable(fresh)).toBe(true);
  await repo.saveDraft({ text: "Fresh writer survives late callbacks", assets: [] }, fresh);
  expect((await repo.load(record.id))?.draft.text).toBe("Fresh writer survives late callbacks");
});

test("the owning client serializes transcript, draft and title writes instead of losing revisions", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const owner = sessionOwner(repo, record);
  const token = await owner.acquire(record.id, record.scopeId);
  await Promise.all([
    owner.save({ ...record.state, lastSequence: 1 }, token),
    owner.saveDraft({ text: "Draft", assets: [] }),
    owner.rename("A session"),
  ]);
  const loaded = await repo.load(record.id);
  expect(loaded?.revision).toBe(3);
  expect(loaded?.state.lastSequence).toBe(1);
  expect(loaded?.draft.text).toBe("Draft");
  expect(loaded?.title).toBe("A session");
  expect(await owner.acquire(record.id, record.scopeId)).toBe(token);
});

test("the secondary client stays read-only without cancelling or taking a live owner's work", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const lost = vi.fn();
  const first = sessionOwner(repo, record, lost);
  const token = await first.acquire(record.id, record.scopeId);
  const second = sessionOwner(repository("second"), record);
  await expect(second.acquire(record.id, record.scopeId)).rejects.toMatchObject({ code: "owned" });
  expect(second.getSnapshot()).toBe("read-only");
  await expect(second.saveDraft({ text: "Cannot write", assets: [] })).rejects.toMatchObject({ code: "owned" });
  await first.check();
  expect(first.isWritable(token)).toBe(true);
  expect(lost).not.toHaveBeenCalled();
});

test("ten-second renewal preserves ownership but a suspended expired tab cannot revive it", async () => {
  vi.useFakeTimers();
  const repo = repository("first");
  const record = await repo.create("project:one");
  const lost = vi.fn();
  const first = sessionOwner(repo, record, lost);
  const token = await first.acquire(record.id, record.scopeId);
  now += 10_000;
  await vi.advanceTimersByTimeAsync(10_000);
  await first.check();
  expect(token.expiresAt).toBe(now + MODRA_LEASE_MS);
  now = token.expiresAt;
  const second = sessionOwner(repository("second"), record);
  const next = await second.acquire(record.id, record.scopeId);
  expect(next.epoch).toBeGreaterThan(token.epoch);
  await expect(first.check()).rejects.toMatchObject({ code: "owned" });
  expect(first.getSnapshot()).toBe("lost");
  expect(lost).toHaveBeenCalledOnce();
  const commit = vi.fn();
  await expect(first.guarded(token, commit)).rejects.toMatchObject({ code: "owned" });
  expect(commit).not.toHaveBeenCalled();
  expect(lost).toHaveBeenCalledOnce();
});

test("takeover stops a real runtime preview and denies its late tools, retries and approvals", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  let runtime: ModraRuntime | undefined;
  const owner = sessionOwner(repo, record, () => runtime?.invalidate());
  await owner.acquire(record.id, record.scopeId);
  const host = new WorkspaceModelingHost(createProcessor(), record.scopeId, () => crypto.randomUUID());
  const fetch = vi.fn();
  let request: ProviderRequest | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  runtime = new ModraRuntime(record.state, {
    repository: owner,
    host,
    clock: { now: () => now, id: () => crypto.randomUUID() },
    credentials: { resolve: () => ({ revision: "one" }), isCurrent: () => true },
    transport: { fetch },
    provider: {
      stream: async function* (value) {
        request = value;
        await value.executeTool("box", "command_scene_createPrimitive", { primitive: "box", name: "Preview" });
        started();
        await new Promise<void>(() => {});
        yield { type: "text-delta", text: "Never resumes" };
      },
    },
  });
  const work = runtime
    .submit({ text: "Build", connection: { providerId: "test", protocol: "openai-compatible", route: "direct" } })
    .catch((error: unknown) => error);
  await ready;
  const change = runtime.getSnapshot().changeSets[0];
  await runtime.enqueue({
    text: "Queued under old owner",
    connection: { providerId: "test", protocol: "openai-compatible", route: "direct" },
  });
  expect(change.status).toBe("staging");
  now += MODRA_LEASE_MS;
  await repository("second").acquire(record.id, record.scopeId);
  await owner.check().catch(() => undefined);
  expect(owner.getSnapshot()).toBe("lost");
  await work;
  expect(runtime.getSnapshot().run?.phase).toBe("stale");
  expect(runtime.getSnapshot().queue?.paused).toBe(true);
  await expect(runtime.resumeQueue()).rejects.toMatchObject({ code: "owned" });
  await expect(runtime.removeQueued(runtime.getSnapshot().queue!.entries[0].id)).rejects.toMatchObject({
    code: "owned",
  });
  expect(runtime.getSnapshot().changeSets[0].status).toBe("stale");
  await expect(request!.executeTool("late", "query_scene_getHierarchy", { limit: 1 })).rejects.toMatchObject({
    code: "ownership-lost",
  });
  await expect(
    request!.transport.fetch("https://models.example/v1/chat/completions", { method: "POST" }),
  ).rejects.toMatchObject({ code: "ownership-lost" });
  await runtime.accept(change.id).catch(() => undefined);
  expect(host.processor.historyLength).toBe(0);
  expect(host.snapshot().document.objects).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

test("a separate memory fallback never writes to the abandoned durable session", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const durable = await repo.acquire(record.id, record.scopeId);
  await repo.saveDraft({ text: "Durable draft", assets: [] }, durable);
  const memory = createMemorySessionRepository("memory", () => now);
  const state = createModraSession("memory-session", "temporary:fallback");
  const token = await memory.acquire(state.id, state.scopeId);
  await memory.save(state, token);
  expect(memory.load(state.id)?.id).toBe("memory-session");
  expect((await repo.load(record.id))?.draft.text).toBe("Durable draft");
  expect(await repo.list()).toHaveLength(1);
});

test("BroadcastChannel only invalidates ownership; durable scope fences remain authoritative", async () => {
  const first = new IndexedDBModraRepository({ name, ownerId: "first", now: () => now });
  const second = new IndexedDBModraRepository({ name, ownerId: "second", now: () => now });
  repositories.push(first, second);
  const record = await first.create("project:one");
  const lost = vi.fn();
  const owner = sessionOwner(first, record, lost);
  const token = await owner.acquire(record.id, record.scopeId);
  const invalidated = new Promise<void>((resolve) => {
    const unsubscribe = owner.subscribe(() => {
      if (owner.getSnapshot() === "lost") {
        unsubscribe();
        resolve();
      }
    });
  });
  await second.seal("scope", record.scopeId);
  await invalidated;
  expect(lost).toHaveBeenCalledOnce();
  expect(owner.isWritable(token)).toBe(false);
  await expect(owner.save(record.state, token)).rejects.toMatchObject({ code: "owned" });
});

test.each(["corrupt", "newer-version"] as const)("%s session data is reported without overwriting it", async (code) => {
  const repo = repository("writer");
  const record = await repo.create("project:one");
  const owner = await repo.acquire(record.id, record.scopeId);
  const stored =
    code === "newer-version"
      ? { ...record, schemaVersion: 10 }
      : {
          ...record,
          state: { ...record.state, messages: [{ id: "broken", role: "assistant" }] },
        };
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = raw.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put(stored);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    await expect(repo.load(record.id)).rejects.toMatchObject({ code });
    await expect(repo.save(record.state, owner)).rejects.toMatchObject({ code });
    const original = await new Promise<unknown>((resolve, reject) => {
      const request = raw.transaction("sessions").objectStore("sessions").get(record.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(original).toEqual(stored);
  } finally {
    raw.close();
  }
});

test("a newer database is not downgraded or deleted, and denied storage stays separate from memory", async () => {
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => request.result.createObjectStore("future");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  raw.close();
  await expect(repository("writer").create("project:one")).rejects.toMatchObject({ code: "newer-version" });
  const denied = new IndexedDBModraRepository({
    factory: {
      open() {
        throw new DOMException("Denied", "SecurityError");
      },
    } as unknown as IDBFactory,
    name: "never-opened",
    notifications: false,
  });
  repositories.push(denied);
  await expect(denied.create("project:one")).rejects.toMatchObject({ code: "unavailable" });
  const memory = createMemorySessionRepository("temporary", () => now);
  const state = createModraSession("new-memory-session", "temporary:fallback");
  await memory.save(state, await memory.acquire(state.id, state.scopeId));
  expect(memory.load(state.id)).toEqual(state);
});
test("queued-only assets survive collection, scope deletion fences queued writes and reclaims only unshared assets", async () => {
  const repo = repository("writer");
  const first = await repo.create("project:queued");
  const second = await repo.create("project:other");
  const owner = await repo.acquire(first.id, first.scopeId);
  const otherOwner = await repo.acquire(second.id, second.scopeId);
  repo.stageAsset(image("queued-only"));
  repo.stageAsset(image("queued-shared"));
  const queued = {
    ...first.state,
    queue: {
      paused: true,
      entries: [
        {
          id: "queued",
          text: "Inspect",
          assets: withImages(first, ["queued-only", "queued-shared"]).messages[0].assets,
          references: [],
          connection: { providerId: "test", protocol: "openai-compatible", route: "direct" as const },
          mode: "build" as const,
          approval: "request" as const,
        },
      ],
    },
  };
  await repo.save(queued, owner);
  await repo.saveDraft(
    { text: "Shared", assets: withImages(second, ["queued-shared"]).messages[0].assets },
    otherOwner,
  );
  await repo.collect(otherOwner);
  expect(await repo.asset("queued-only")).not.toBeNull();
  expect((await repo.load(first.id))?.state.queue?.entries[0].assets).toHaveLength(2);
  const seal = await repo.seal("scope", first.scopeId);
  await expect(repo.save(queued, owner)).rejects.toMatchObject({ code: "owned" });
  await repo.cleanup(seal);
  expect(await repo.load(first.id)).toBeNull();
  expect(await repo.asset("queued-only")).toBeNull();
  expect(await repo.asset("queued-shared")).not.toBeNull();
});

test("transient drafts and image blobs promote atomically only on a user message or manual name", async () => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.createTransient("temporary:lazy");
  const token = await first.acquire(record.id, record.scopeId);
  const asset = image("draft-only");
  first.stageAsset(asset);
  const { blob: _blob, ...reference } = asset;
  await first.save(record.state, token);
  await first.saveDraft({ text: "Unsent", assets: [reference] }, token);
  expect(await second.load(record.id)).toBeNull();
  expect(await second.asset(asset.assetId)).toBeNull();
  expect(await first.list()).toHaveLength(0);
  expect((await first.load(record.id))!.draft.text).toBe("Unsent");
  await first.save(withImages(record, [asset.assetId]), token);
  expect(await second.list()).toHaveLength(1);
  expect((await second.load(record.id))!.state.messages).toHaveLength(1);
  expect((await second.asset(asset.assetId))!.blob.size).toBe(3);
  const named = await first.createTransient(record.scopeId);
  const namedToken = await first.acquire(named.id, named.scopeId);
  await first.rename("Named task", namedToken);
  expect((await second.load(named.id))!.titleSource).toBe("manual");
  expect(await second.list()).toHaveLength(2);
});

test("abandonment removes only unsaved temporary scopes and fences late writes", async () => {
  const first = repository("first");
  const record = await first.createTransient("temporary:discarded");
  const token = await first.acquire(record.id, record.scopeId);
  first.stageAsset(image("discarded-image"));
  await first.save(withImages(record, ["discarded-image"]), token);
  await first.discardTemporaryScope(record.scopeId, []);
  expect(await first.load(record.id)).toBeNull();
  expect(await first.asset("discarded-image")).toBeNull();
  await expect(first.save(record.state, token)).rejects.toMatchObject({ code: "fenced" });
  const saved = await first.createTransient("temporary:saved");
  const savedToken = await first.acquire(saved.id, saved.scopeId);
  await first.rename("Keep", savedToken);
  const association = await first.prepareProjectScope(saved.scopeId);
  await first.discardTemporaryScope(saved.scopeId, [association.projectId]);
  expect(await first.load(saved.id)).not.toBeNull();
  await first.assertWritable(savedToken);
});

test("recovery checks only newly marked temporary histories and respects other tabs and current scope", async () => {
  const first = repository("first");
  const second = repository("second");
  const legacy = await first.create("temporary:legacy");
  const live = await first.createTransient("temporary:live");
  const token = await first.acquire(live.id, live.scopeId);
  await first.rename("In another tab", token);
  await second.collectAbandonedTemporaryScopes([], "temporary:current");
  expect(await second.load(live.id)).not.toBeNull();
  now += MODRA_LEASE_MS + 1;
  await second.collectAbandonedTemporaryScopes([], live.scopeId);
  expect(await second.load(live.id)).not.toBeNull();
  await second.collectAbandonedTemporaryScopes([], "temporary:current");
  expect(await second.load(live.id)).toBeNull();
  expect(await second.load(legacy.id)).not.toBeNull();
});

test("automatic recovery cannot delete a frozen tab's workspace after its writer lease expires", async () => {
  const first = repository("first");
  const second = repository("second");
  const record = await first.createTransient("temporary:frozen-tab");
  const token = await first.acquire(record.id, record.scopeId);
  await first.rename("Frozen tab", token);
  const lock = holdTemporaryScope(record.scopeId);
  try {
    expect(await lock.ready).toBe(true);
    now += MODRA_LEASE_MS + 1;
    await second.collectAbandonedTemporaryScopes([], "temporary:another-page");
    expect(await second.load(record.id)).not.toBeNull();
  } finally {
    lock.close();
  }
  await second.collectAbandonedTemporaryScopes([], "temporary:another-page");
  expect(await second.load(record.id)).toBeNull();
});