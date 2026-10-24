import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { IndexedDBModraRepository, MODRA_LEASE_MS } from "../src/modra/storage/indexeddb-repository";
import type { SessionRecord } from "../src/modra/storage/indexeddb-repository";
import {
  bindSessionOwnerLifecycle,
  openDurableSession,
  type OpenDurableSession,
} from "../src/modra/storage/open-session";
import { DurableModraSession } from "../src/modra/controller/durable-session";
import {
  ModraRuntime,
  type ModraSessionState,
  type ProviderPort,
  type SessionRepositoryPort,
} from "@open-3d/ai/runtime";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { createProcessor } from "../src/workspace/modeling";

let name: string;
let now: number;
let repositories: IndexedDBModraRepository[];
let handles: OpenDurableSession[];
let unbind: (() => void)[];
let controllers: DurableModraSession[];
const connection = { providerId: "test", protocol: "openai-compatible", route: "direct" as const };
async function controller(repository: IndexedDBModraRepository, record: SessionRecord, provider: ProviderPort) {
  const host = new WorkspaceModelingHost(createProcessor(), record.scopeId, () => crypto.randomUUID());
  const opened = await DurableModraSession.open(
    repository,
    host,
    record,
    (state: ModraSessionState, owner: SessionRepositoryPort) =>
      new ModraRuntime(state, {
        host,
        repository: owner,
        provider,
        clock: { now: () => now, id: () => crypto.randomUUID() },
        credentials: { resolve: () => ({ revision: "one" }), isCurrent: () => true },
        transport: { fetch: vi.fn() },
      }),
  );
  controllers.push(opened);
  return { opened, host };
}
function repository(ownerId: string) {
  const repository = new IndexedDBModraRepository({ name, ownerId, now: () => now, notifications: false });
  repositories.push(repository);
  return repository;
}
async function open(repository: IndexedDBModraRepository, record: SessionRecord, onLost = vi.fn()) {
  const handle = await openDurableSession(repository, record.id, record.scopeId, { onLost });
  handles.push(handle);
  return handle;
}
async function interruptedRecord(repository: IndexedDBModraRepository) {
  const record = await repository.create("project:one");
  const token = await repository.acquire(record.id, record.scopeId);
  const base = { scopeId: record.scopeId, generationId: "old-generation", mutationVersion: 0 };
  const run = {
    id: "run",
    taskId: "task",
    messageId: "reply",
    mode: "build" as const,
    approval: "auto" as const,
    phase: "awaiting-review" as const,
    outcome: "completed" as const,
    base,
  };
  record.state = {
    ...record.state,
    lastSequence: 4,
    run,
    runs: [run],
    messages: [
      {
        id: "reply",
        runId: run.id,
        taskId: run.taskId,
        base,
        role: "assistant",
        text: "A saved reply",
        assets: [],
        changeSetId: "change",
        toolCalls: [{ id: "tool", name: "scene.getHierarchy", status: "running" }],
      },
    ],
    changeSets: [
      {
        id: "change",
        runId: run.id,
        taskId: run.taskId,
        messageId: run.messageId,
        base,
        commands: [],
        status: "pending",
        interrupted: false,
        effect: "obsolete",
      },
    ],
  };
  await repository.save(record.state, token);
  return { record, token };
}

beforeEach(() => {
  name = `modra-open-${crypto.randomUUID()}`;
  now = 1000;
  repositories = [];
  handles = [];
  unbind = [];
  controllers = [];
});
afterEach(async () => {
  unbind.forEach((remove) => remove());
  await Promise.all(controllers.map((controller) => controller.close()));
  await Promise.all(handles.map((handle) => handle.owner.close()));
  await Promise.all(repositories.map((repository) => repository.close()));
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error);
  });
});

test("opening another live owner's session is read-only and never recovers or writes it", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  const fetch = vi.spyOn(globalThis, "fetch");
  const opened = await open(repository("second"), record);
  expect(opened.readOnly).toBe(true);
  expect(opened.owner.getSnapshot()).toBe("read-only");
  expect(opened.record.state).toEqual(record.state);
  expect((await first.load(record.id))?.revision).toBe(1);
  await expect(opened.owner.saveDraft({ text: "Cannot replace draft", assets: [] })).rejects.toMatchObject({
    code: "owned",
  });
  await first.assertWritable(token);
  expect(fetch).not.toHaveBeenCalled();
});

test("reopening abandoned auto-approval work acquires a new epoch before recovery, never replaying it", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  now += MODRA_LEASE_MS;
  const fetch = vi.spyOn(globalThis, "fetch");
  const second = repository("second");
  const opened = await open(second, record);
  expect(opened.readOnly).toBe(false);
  const ownership = await opened.owner.acquire(record.id, record.scopeId);
  expect(ownership.epoch).toBeGreaterThan(token.epoch);
  expect(opened.record.state.run).toMatchObject({ phase: "cancelled", error: "interrupted" });
  expect(opened.record.state.changeSets[0]).toMatchObject({ status: "stale", effect: "obsolete" });
  expect(opened.record.state.messages[0].toolCalls[0].status).toBe("cancelled");
  expect((await second.load(record.id))?.state).toEqual(opened.record.state);
  await expect(first.save(record.state, token)).rejects.toMatchObject({ code: "owned" });
  expect(fetch).not.toHaveBeenCalled();
});

test("reopens shared draft/history image references locally without fetching", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  const asset = { assetId: "image", name: "reference.png", mediaType: "image/png", byteLength: 3 };
  first.stageAsset({ ...asset, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
  const state = { ...record.state, lastSequence: 5, messages: [{ ...record.state.messages[0], assets: [asset] }] };
  await first.save(state, token);
  await first.saveDraft({ text: "Use reference", assets: [asset] }, token);
  await first.release(token);
  const fetch = vi.spyOn(globalThis, "fetch");
  const opened = await open(repository("second"), record);
  expect(opened.assets.size).toBe(1);
  expect(opened.assets.get(asset.assetId)).toEqual({
    id: asset.assetId,
    name: asset.name,
    mediaType: asset.mediaType,
    dataUrl: "data:image/png;base64,AQID",
  });
  expect(opened.record.draft).toEqual({ text: "Use reference", assets: [asset] });
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["focus", "visibilitychange"])(
  "%s invalidates an expired suspended owner without reviving it",
  async (event) => {
    const first = repository("first");
    const record = await first.create("project:one");
    const lost = vi.fn();
    const handle = await open(first, record, lost);
    unbind.push(bindSessionOwnerLifecycle(handle.owner, window, document));
    now += MODRA_LEASE_MS;
    const second = repository("second");
    await second.acquire(record.id, record.scopeId);
    (event === "focus" ? window : document).dispatchEvent(new Event(event));
    await expect.poll(() => handle.owner.getSnapshot()).toBe("lost");
    expect(lost).toHaveBeenCalledOnce();
    expect((await second.load(record.id))?.revision).toBe(1);
  },
);

test("cancelling an opening during evidence hashing releases its lease without recovery writes", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  await first.release(token);
  const controller = new AbortController();
  await expect(
    openDurableSession(repository("second"), record.id, record.scopeId, {
      onLost: vi.fn(),
      signal: controller.signal,
      evidence: async () => {
        controller.abort();
        return { algorithm: "sha256-native-v1", digest: "a".repeat(64) };
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect((await first.load(record.id))?.revision).toBe(1);
  await expect(repository("third").acquire(record.id, record.scopeId)).resolves.toMatchObject({ ownerId: "third" });
});

test("ownership expiring during hashing prevents recovery from writing a stale snapshot", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  await first.release(token);
  const third = repository("third");
  await expect(
    openDurableSession(repository("second"), record.id, record.scopeId, {
      onLost: vi.fn(),
      evidence: async () => {
        now += MODRA_LEASE_MS;
        await third.acquire(record.id, record.scopeId);
        return { algorithm: "sha256-native-v1", digest: "a".repeat(64) };
      },
    }),
  ).rejects.toMatchObject({ code: "owned" });
  expect((await third.load(record.id))?.state).toEqual(record.state);
});

test("first-save association preserves the live writer, scope, draft and pending preview identity", async () => {
  const first = repository("first");
  const record = await first.create("temporary:workspace");
  const handle = await open(first, record);
  const token = await handle.owner.acquire(record.id, record.scopeId);
  await handle.owner.saveDraft({ text: "Keep the draft", assets: [] });
  const before = await first.load(record.id);
  const prepared = await first.prepareProjectScope(record.scopeId);
  expect(prepared.scopeId).toBe(record.scopeId);
  expect(await first.prepareProjectScope(record.scopeId)).toEqual(prepared);
  expect(await first.scopeForProject(prepared.projectId)).toBe(record.scopeId);
  expect(await first.load(record.id)).toEqual(before);
  await handle.owner.assertWritable(token);
  await handle.owner.save({ ...record.state, lastSequence: 2 }, token);
  expect((await first.list(record.scopeId)).map((session) => session.id)).toEqual([record.id]);
});

test("a prepared save survives reopening even if its completion notification was lost", async () => {
  const first = repository("first");
  const record = await first.create("temporary:original");
  const prepared = await first.prepareProjectScope(record.scopeId);
  await first.close();
  const second = repository("second");
  expect(await second.scopeForProject(prepared.projectId)).toBe(record.scopeId);
  expect((await second.list(await second.scopeForProject(prepared.projectId))).map((session) => session.id)).toEqual([
    record.id,
  ]);
  // An unsuccessful scene save still leaves an unattached temporary history, never a restored scene.
  expect((await second.list()).map((session) => session.scopeId)).toEqual(["temporary:original"]);
});

test("duplicated/imported project record IDs do not inherit links from a matching document ID", async () => {
  const first = repository("first");
  const record = await first.create("temporary:original");
  const prepared = await first.prepareProjectScope(record.scopeId, "saved-record");
  expect(await first.scopeForProject(prepared.projectId)).toBe("temporary:original");
  expect(await first.scopeForProject("duplicated-record")).toBe("project:duplicated-record");
  expect(await first.scopeForProject("imported-record")).toBe("project:imported-record");
  expect(await first.list(await first.scopeForProject("duplicated-record"))).toEqual([]);
  const imported = await first.create("temporary:imported");
  expect(imported.id).not.toBe(record.id);
  await expect(first.prepareProjectScope(imported.scopeId, prepared.projectId)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("concurrent first-save preparation cannot bind one project to two temporary scopes", async () => {
  const first = repository("first");
  const second = repository("second");
  const outcomes = await Promise.allSettled([
    first.prepareProjectScope("temporary:one", "same-project"),
    second.prepareProjectScope("temporary:two", "same-project"),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  const winner = outcomes.find((outcome) => outcome.status === "fulfilled")!;
  expect(await first.scopeForProject("same-project")).toBe(winner.value.scopeId);
});

test("sealed scopes and existing default project history cannot be adopted or resurrected", async () => {
  const first = repository("first");
  await first.seal("scope", "temporary:deleted");
  await expect(first.prepareProjectScope("temporary:deleted")).rejects.toMatchObject({ code: "fenced" });
  await first.create("project:existing");
  await expect(first.prepareProjectScope("temporary:new", "existing")).rejects.toMatchObject({ code: "conflict" });
  expect(await first.scopeForProject("existing")).toBe("project:existing");
});

test("the browser session controller refuses every mutating action from a live secondary", async () => {
  const first = repository("first");
  const { record, token } = await interruptedRecord(first);
  const stream = vi.fn(async function* () {
    yield { type: "text-delta" as const, text: "Must not dispatch" };
  });
  const { opened, host } = await controller(repository("second"), record, { stream });
  expect(opened.getDurability()).toBe("read-only");
  await expect(opened.submit({ text: "No request", connection })).rejects.toMatchObject({ code: "owned" });
  await expect(opened.accept("change")).rejects.toMatchObject({ code: "owned" });
  await expect(opened.reject("change")).rejects.toMatchObject({ code: "owned" });
  await expect(opened.rename("No title change")).rejects.toMatchObject({ code: "owned" });
  await expect(opened.saveDraft({ text: "No draft change", assets: [] })).rejects.toMatchObject({ code: "owned" });
  expect(() =>
    opened.attach([{ id: "image", name: "file.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AQ==" }]),
  ).toThrow("modra-storage.owned");
  opened.cancel();
  expect(opened.getSnapshot()).toEqual(record.state);
  await opened.close();
  expect((await first.load(record.id))?.state).toEqual(record.state);
  await first.assertWritable(token);
  expect(stream).not.toHaveBeenCalled();
  expect(host.processor.historyLength).toBe(0);
});

test("controller attachment reuse preserves exact decoded lengths and writes draft/messages atomically", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const { opened } = await controller(repo, record, {
    stream: async function* () {
      yield { type: "text-delta", text: "Done" };
    },
  });
  const image = { id: "image", name: "reference.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AQ==" };
  const assets = opened.attach([image]);
  expect(assets[0].byteLength).toBe(1);
  expect(opened.attach([image])).toEqual(assets);
  await opened.saveDraft({ text: "Reference draft", assets });
  await opened.submit({ text: "Use reference", assets, connection });
  expect(opened.getDurability()).toBe("saved");
  expect((await repo.load(record.id))?.state.messages[0].assets).toEqual(assets);
  await opened.close();
  const reopened = await open(repository("second"), record);
  expect(reopened.assets.get("image")).toEqual(image);
  expect(reopened.record.draft.assets).toEqual(assets);
});

test("close during generation cancels and flushes before releasing the writer for a request-free reopen", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const stream = vi.fn(async function* () {
    yield { type: "text-delta" as const, text: "Partial answer" };
    await new Promise<void>(() => {});
  });
  const { opened } = await controller(repo, record, { stream });
  const work = opened.submit({ text: "Build", connection });
  await expect.poll(() => opened.getSnapshot().messages.at(-1)?.text).toBe("Partial answer");
  await opened.close();
  await work;
  const saved = await repo.load(record.id);
  expect(saved?.state.run?.phase).toBe("cancelled");
  expect(saved?.state.messages.at(-1)?.text).toBe("Partial answer");
  const second = repository("second");
  const reopened = await open(second, record);
  expect(reopened.readOnly).toBe(false);
  expect(reopened.record.state.messages.at(-1)?.text).toBe("Partial answer");
  expect(stream).toHaveBeenCalledOnce();
});

test("closing while ownership acquisition is pending cannot dispatch after the close", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const stream = vi.fn(async function* () {
    yield { type: "text-delta" as const, text: "Must not dispatch" };
  });
  const { opened } = await controller(repo, record, { stream });
  const outcome = opened.submit({ text: "Build", connection }).catch((error: unknown) => error);
  await opened.close();
  expect(await outcome).toMatchObject({ code: "owned" });
  expect(stream).not.toHaveBeenCalled();
  expect((await repo.load(record.id))?.state.messages).toEqual([]);
});

test("a failed transcript flush stays unsaved after an unrelated title write and retains image bytes", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const { opened } = await controller(repo, record, {
    stream: async function* () {
      yield { type: "text-delta", text: "Keep this response" };
    },
  });
  const image = { id: "image", name: "reference.png", mediaType: "image/png", dataUrl: "data:image/png;base64,AQ==" };
  const assets = opened.attach([image]);
  const save = vi.spyOn(repo, "save").mockRejectedValue(new DOMException("full", "QuotaExceededError"));
  await expect(opened.submit({ text: "Inspect", assets, connection })).rejects.toMatchObject({
    name: "QuotaExceededError",
  });
  expect(opened.getDurability()).toBe("error");
  expect(opened.assets.get(image.id)).toEqual(image);
  expect(opened.getSnapshot().messages.at(-1)?.text).toBe("Keep this response");
  expect((await repo.load(record.id))?.state.messages).toEqual([]);
  await opened.rename("A title is not the transcript");
  expect(opened.getDurability()).toBe("error");
  save.mockRestore();
  await opened.submit({ text: "Continue after freeing storage", connection });
  expect(opened.getDurability()).toBe("saved");
  expect((await repo.load(record.id))?.state.messages[0].assets).toEqual(assets);
  expect((await repo.asset(image.id))?.blob.size).toBe(1);
});

test("focus checks stop an actual controller's preview after background-tab lease expiry", async () => {
  const repo = repository("first");
  const record = await repo.create("project:one");
  const { opened, host } = await controller(repo, record, {
    stream: async function* (request) {
      await request.executeTool("create", "command_scene_createPrimitive", { primitive: "box", name: "Preview" });
      yield { type: "text-delta", text: "Inspecting preview" };
      await new Promise<void>(() => {});
    },
  });
  let preview: unknown;
  unbind.push(
    host.subscribe((event) => {
      if (event.type === "preview") preview = event.document;
    }),
  );
  const outcome = opened.submit({ text: "Build", connection }).catch((error: unknown) => error);
  await expect.poll(() => opened.getSnapshot().messages.at(-1)?.text).toBe("Inspecting preview");
  expect(preview).not.toBeNull();
  now += MODRA_LEASE_MS;
  const second = repository("second");
  const next = await second.acquire(record.id, record.scopeId);
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => opened.getDurability()).toBe("lost");
  await outcome;
  expect(opened.getSnapshot().run?.phase).toBe("stale");
  expect(preview).toBeNull();
  expect(host.processor.historyLength).toBe(0);
  await expect(opened.accept(opened.getSnapshot().changeSets[0].id)).rejects.toMatchObject({ code: "owned" });
  await opened.close();
  await second.assertWritable(next);
});