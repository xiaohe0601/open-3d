import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { LocalProjectStorageError } from "@open-3d/projects";
import { IndexedDBModraRepository, MODRA_LEASE_MS } from "../src/modra/storage/indexeddb-repository";
import { removeProjectWithSessions } from "../src/modra/storage/project-deletion";
import { DurableModraSession } from "../src/modra/controller/durable-session";
import { ModraRuntime } from "@open-3d/ai/runtime";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { createProcessor } from "../src/workspace/modeling";

let name: string;
let now: number;
let repositories: IndexedDBModraRepository[];
let controllers: DurableModraSession[];
function repository(ownerId = crypto.randomUUID()) {
  const repo = new IndexedDBModraRepository({ name, ownerId, now: () => now, notifications: false });
  repositories.push(repo);
  return repo;
}
beforeEach(() => {
  name = `modra-deletion-${crypto.randomUUID()}`;
  now = 1000;
  repositories = [];
  controllers = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(controllers.map((controller) => controller.close()));
  await Promise.all(repositories.map((repo) => repo.close()));
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

test("seals associated and canonical scopes before removal and retains unrelated references", async () => {
  const writer = repository();
  const record = await writer.create("temporary:scene");
  const association = await writer.prepareProjectScope(record.scopeId, "project");
  const other = await writer.create("project:other");
  const token = await writer.acquire(record.id, record.scopeId);
  const otherToken = await writer.acquire(other.id, other.scopeId);
  const asset = { assetId: "shared", name: "Reference", mediaType: "image/png", byteLength: 3 };
  writer.stageAsset({ ...asset, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
  await writer.saveDraft({ text: "Deleted draft", assets: [asset] }, token);
  await writer.saveDraft({ text: "Other draft", assets: [asset] }, otherToken);
  const deletion = repository();
  const remove = vi.fn(async () => {
    await expect(writer.saveDraft({ text: "Late", assets: [] }, token)).rejects.toMatchObject({ code: "fenced" });
    await expect(writer.create(record.scopeId)).rejects.toMatchObject({ code: "fenced" });
    await expect(writer.create("project:project")).rejects.toMatchObject({ code: "fenced" });
    await expect(writer.scopeForProject(association.projectId)).rejects.toMatchObject({ code: "fenced" });
    expect((await deletion.projectDeletions())[0].phase).toBe("removing");
  });
  await removeProjectWithSessions(deletion, { remove }, association.projectId, vi.fn());
  expect(remove).toHaveBeenCalledOnce();
  expect(await deletion.load(record.id)).toBeNull();
  expect((await deletion.load(other.id))?.draft.text).toBe("Other draft");
  expect(await deletion.asset(asset.assetId)).not.toBeNull();
  expect(await deletion.projectDeletions()).toEqual([]);
  await removeProjectWithSessions(deletion, { remove }, association.projectId, vi.fn());
  expect(remove).toHaveBeenCalledOnce();
  await writer.saveDraft({ text: "Unrelated remains writable", assets: [] }, otherToken);
});

test("fence storage failure prevents project removal and scene detachment", async () => {
  const repo = repository();
  await repo.create("project:one");
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "fences") throw new DOMException("Denied", "SecurityError");
    return put.call(this, value, key);
  });
  const remove = vi.fn();
  const detach = vi.fn();
  await expect(removeProjectWithSessions(repo, { remove }, "one", detach)).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(remove).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(await repo.projectDeletions()).toEqual([]);
  expect((await repo.create("project:one")).scopeId).toBe("project:one");
});

test("failed project removal retains sealed history and explicit cancellation uses fresh epochs", async () => {
  const repo = repository();
  const record = await repo.create("project:one");
  const token = await repo.acquire(record.id, record.scopeId);
  await repo.saveDraft({ text: "Retained draft", assets: [] }, token);
  const remove = vi.fn().mockRejectedValue(new LocalProjectStorageError("failed", "Denied"));
  await expect(removeProjectWithSessions(repo, { remove }, "one", vi.fn())).rejects.toMatchObject({ code: "failed" });
  expect((await repo.projectDeletions())[0].phase).toBe("remove-failed");
  expect((await repo.load(record.id))?.draft.text).toBe("Retained draft");
  await repo.cancelProjectDeletion("one");
  await expect(repo.saveDraft({ text: "Old callback", assets: [] }, token)).rejects.toMatchObject({ code: "owned" });
  const fresh = await repo.acquire(record.id, record.scopeId);
  expect(fresh.epoch).toBeGreaterThan(token.epoch);
  await repo.saveDraft({ text: "New writer", assets: [] }, fresh);
  expect(await repo.projectDeletions()).toEqual([]);
  const next = await repo.beginProjectDeletion("one");
  expect(next.epoch).toBeGreaterThan(1);
});

test("cleanup failure survives reload and retries without removing the project twice", async () => {
  const repo = repository();
  const record = await repo.create("project:one");
  const remove = vi.fn(async () => {});
  const cleanup = vi.spyOn(repo, "completeProjectDeletion").mockRejectedValueOnce(new Error("Cleanup unavailable"));
  await expect(removeProjectWithSessions(repo, { remove }, "one", vi.fn())).rejects.toThrow("Cleanup unavailable");
  expect((await repo.projectDeletions())[0].phase).toBe("removed");
  expect(await repo.load(record.id)).not.toBeNull();
  await expect(repo.cancelProjectDeletion("one")).rejects.toMatchObject({ code: "conflict" });
  cleanup.mockRestore();
  const reopened = repository();
  await removeProjectWithSessions(reopened, { remove }, "one", vi.fn());
  expect(remove).toHaveBeenCalledOnce();
  expect(await reopened.load(record.id)).toBeNull();
  expect(await reopened.projectDeletions()).toEqual([]);
  await expect(reopened.create(record.scopeId)).rejects.toMatchObject({ code: "fenced" });
});

test("a lost removal receipt is reconciled through idempotent not-found retry", async () => {
  const repo = repository();
  const record = await repo.create("project:one");
  await repo.beginProjectDeletion("one");
  await repo.claimProjectRemoval("one");
  // The project database committed, but the tab closed before recording the receipt.
  now += MODRA_LEASE_MS;
  const reopened = repository();
  const remove = vi.fn().mockRejectedValue(new LocalProjectStorageError("not-found", "Already removed"));
  await removeProjectWithSessions(reopened, { remove }, "one", vi.fn());
  expect(await reopened.load(record.id)).toBeNull();
  expect(await reopened.projectDeletions()).toEqual([]);
});

test("live removal cannot be cancelled or dispatched twice from another tab", async () => {
  const repo = repository();
  await repo.create("project:one");
  await repo.beginProjectDeletion("one");
  const claim = await repo.claimProjectRemoval("one");
  const second = repository();
  const remove = vi.fn();
  await expect(removeProjectWithSessions(second, { remove }, "one", vi.fn())).rejects.toMatchObject({ code: "owned" });
  expect(remove).not.toHaveBeenCalled();
  await expect(second.cancelProjectDeletion("one")).rejects.toMatchObject({ code: "conflict" });
  await repo.finishProjectRemoval(claim, false);
  await second.cancelProjectDeletion("one");
});

test("a superseding canonical scope fence cannot be reopened by an old associated deletion", async () => {
  const repo = repository();
  await repo.create("temporary:associated");
  await repo.prepareProjectScope("temporary:associated", "one");
  await repo.beginProjectDeletion("one");
  await repository().seal("scope", "project:one");
  await expect(repo.cancelProjectDeletion("one")).rejects.toMatchObject({ code: "fenced" });
  await expect(repo.claimProjectRemoval("one")).rejects.toMatchObject({ code: "fenced" });
  await expect(repo.create("temporary:associated")).rejects.toMatchObject({ code: "fenced" });
});

test("a failed second scope seal rolls back intent and both fences before any removal", async () => {
  const repo = repository();
  await repo.create("temporary:associated");
  await repo.prepareProjectScope("temporary:associated", "one");
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "fences" && value.id === "scope:project:one")
      throw new DOMException("Full", "QuotaExceededError");
    return put.call(this, value, key);
  });
  const remove = vi.fn();
  await expect(removeProjectWithSessions(repo, { remove }, "one", vi.fn())).rejects.toMatchObject({ code: "quota" });
  vi.restoreAllMocks();
  expect(remove).not.toHaveBeenCalled();
  expect(await repo.projectDeletions()).toEqual([]);
  await repo.create("temporary:associated");
  await repo.create("project:one");
});

test("cleanup and completion receipt commit atomically, including asset reclamation", async () => {
  const repo = repository();
  const record = await repo.create("project:one");
  const token = await repo.acquire(record.id, record.scopeId);
  const asset = { assetId: "only-reference", name: "Reference", mediaType: "image/png", byteLength: 3 };
  repo.stageAsset({ ...asset, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) });
  await repo.saveDraft({ text: "Recover on failure", assets: [asset] }, token);
  await repo.beginProjectDeletion("one");
  await repo.finishProjectRemoval(await repo.claimProjectRemoval("one"), true);
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === "fences" && value.phase === "complete") throw new DOMException("Denied", "SecurityError");
    return put.call(this, value, key);
  });
  await expect(repo.completeProjectDeletion("one")).rejects.toMatchObject({ code: "unavailable" });
  vi.restoreAllMocks();
  const reader = repository();
  expect(await reader.load(record.id)).not.toBeNull();
  expect(await reader.asset(asset.assetId)).not.toBeNull();
  expect((await reader.projectDeletions())[0].phase).toBe("removed");
  await reader.completeProjectDeletion("one");
  expect(await reader.load(record.id)).toBeNull();
  expect(await reader.asset(asset.assetId)).toBeNull();
});

test("an abandoned dispatch never becomes cancellable after a recovered retry fails", async () => {
  const first = repository();
  await first.create("project:one");
  await first.beginProjectDeletion("one");
  const abandoned = await first.claimProjectRemoval("one");
  now += MODRA_LEASE_MS;
  const second = repository();
  const failed = vi.fn().mockRejectedValue(new LocalProjectStorageError("failed", "Denied"));
  await expect(removeProjectWithSessions(second, { remove: failed }, "one", vi.fn())).rejects.toMatchObject({
    code: "failed",
  });
  expect((await second.projectDeletions())[0].phase).toBe("removing");
  await expect(second.cancelProjectDeletion("one")).rejects.toMatchObject({ code: "conflict" });
  await expect(first.finishProjectRemoval(abandoned, false)).rejects.toMatchObject({ code: "conflict" });
  await expect(first.finishProjectRemoval(abandoned, true)).rejects.toMatchObject({ code: "conflict" });
  const remove = vi.fn(async () => {});
  await removeProjectWithSessions(second, { remove }, "one", vi.fn());
  expect(remove).toHaveBeenCalledOnce();
});

test.each(["stream", "review"] as const)(
  "deletion during %s invalidates real tools, preview and approval while retaining scene history",
  async (phase) => {
    const repo = repository();
    const record = await repo.create("project:one");
    const host = new WorkspaceModelingHost(createProcessor(), record.scopeId, () => crypto.randomUUID());
    host.adoptSavedProject("one");
    host.execute([{ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Keep scene" } }]);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const session = await DurableModraSession.open(
      repo,
      host,
      record,
      (state, owner) =>
        new ModraRuntime(state, {
          host,
          repository: owner,
          clock: { now: () => now, id: () => crypto.randomUUID() },
          credentials: { resolve: () => ({ revision: "one" }), isCurrent: () => true },
          transport: { fetch: vi.fn() },
          provider: {
            stream: async function* (request) {
              await request.executeTool("box", "command_scene_createPrimitive", {
                primitive: "box",
                name: "Discard preview",
              });
              ready();
              if (phase === "stream") await new Promise<void>(() => {});
              yield { type: "text-delta", text: "Review this preview" };
            },
          },
        }),
    );
    controllers.push(session);
    const work = session
      .submit({
        text: "Build",
        connection: { providerId: "test", protocol: "openai-compatible", route: "direct" },
      })
      .catch((error: unknown) => error);
    await started;
    if (phase === "review") await work;
    const change = session.getSnapshot().changeSets[0];
    const base = host.snapshot().version;
    const deletion = repository();
    await removeProjectWithSessions(deletion, { remove: async () => {} }, "one", () =>
      host.detachScope("temporary:retained"),
    );
    const outcome = await work;
    if (outcome) expect(outcome).toMatchObject({ code: expect.stringMatching(/^(owned|fenced)$/) });
    expect(session.getSnapshot().changeSets[0].status).toBe("stale");
    await expect(session.accept(change.id)).rejects.toMatchObject({ code: "owned" });
    expect(host.snapshot().document.objects.map((item) => item.name)).toEqual(["Keep scene"]);
    expect(host.processor.historyLength).toBe(1);
    expect(host.savedProjectId).toBeUndefined();
    expect(host.snapshot().version.generationId).not.toBe(base.generationId);
    expect(host.snapshot().version.scopeId).toBe("temporary:retained");
    const savedAgain = await deletion.prepareProjectScope("temporary:retained");
    expect(savedAgain.projectId).not.toBe("one");
    expect(await deletion.list(savedAgain.scopeId)).toEqual([]);
    expect(host.undo()).toBe(true);
    expect(host.snapshot().document.objects).toEqual([]);
  },
);