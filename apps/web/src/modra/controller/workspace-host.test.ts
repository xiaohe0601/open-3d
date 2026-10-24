import { expect, test } from "vite-plus/test";
import { createProcessor, emptyDocument } from "../../workspace/modeling";
import { WorkspaceModelingHost, type WorkspaceHostEvent } from "./workspace-host";

const box = [{ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Box" } }];
function fixture() {
  let serial = 0;
  const host = new WorkspaceModelingHost(createProcessor(), "temporary-scope", () => `generation-${++serial}`);
  const events: WorkspaceHostEvent[] = [];
  host.subscribe((event) => events.push(event));
  return { host, events };
}

test("whole batches commit atomically once and duplicate approval stays rejected after Undo", () => {
  const { host, events } = fixture();
  const base = host.snapshot();
  host.commit("change", base.version, box);
  expect(host.processor.historyLength).toBe(1);
  expect(() => host.commit("change", base.version, box)).toThrow();
  expect(host.undo()).toBe(true);
  expect(host.snapshot().document.objects).toHaveLength(0);
  expect(() => host.commit("change", host.snapshot().version, box)).toThrow("already-applied");
  expect(host.processor.historyLength).toBe(0);
  expect(host.redo()).toBe(true);
  expect(host.snapshot().document.objects).toHaveLength(1);
  expect(events.filter((event) => event.type === "changed").map((event) => event.effects.at(-1)?.effect)).toEqual([
    "present",
    "undone",
    "present",
  ]);
});

test.each(["edit", "undo"])("%s before approval rejects an old batch without mutation", (action) => {
  const { host } = fixture();
  if (action === "undo") host.execute(box);
  const base = host.snapshot();
  host.preview("pending", base.version, base.document);
  if (action === "undo") host.undo();
  else host.execute([{ commandId: "document.rename", arguments: { name: "Manual name" } }]);
  const before = host.snapshot();
  expect(() => host.commit("pending", base.version, box)).toThrow("stale-change-set");
  expect(host.snapshot()).toEqual(before);
});

test("replacement with the same document ID invalidates late preview/commit and old cleanup cannot erase new preview", () => {
  const { host, events } = fixture();
  const old = host.snapshot();
  host.preview("old", old.version, old.document);
  host.replace(createProcessor({ ...emptyDocument(), name: "Replacement" }), "saved-record-scope", "record-id");
  expect(host.snapshot().document.id).toBe(old.document.id);
  expect(host.snapshot().version.generationId).not.toBe(old.version.generationId);
  expect(() => host.preview("old", old.version, old.document)).toThrow("stale-change-set");
  expect(() => host.commit("old", old.version, box)).toThrow("stale-change-set");
  const current = host.snapshot();
  host.preview("new", current.version, current.document);
  const count = events.length;
  host.preview("old", old.version, null);
  expect(events).toHaveLength(count);
  expect(host.processor.historyLength).toBe(0);
});

test("first save adopts the temporary scope; deleting the active record detaches scope without losing scene/history", () => {
  const { host } = fixture();
  host.execute(box);
  const before = host.snapshot();
  host.adoptSavedProject("record-1");
  expect(host.snapshot()).toEqual(before);
  expect(host.savedProjectId).toBe("record-1");
  host.detachScope("fresh-temporary-scope");
  expect(host.savedProjectId).toBeUndefined();
  expect(host.snapshot().document).toEqual(before.document);
  expect(host.processor.historyLength).toBe(1);
  expect(host.snapshot().version.generationId).not.toBe(before.version.generationId);
  expect(() => host.commit("old", before.version, box)).toThrow();
  expect(host.undo()).toBe(true);
});

test("transient transform ownership blocks commits and cancelling the gesture does not revive old proposals", () => {
  const { host } = fixture();
  const base = host.snapshot();
  expect(host.beginTransient()).toBe(true);
  expect(host.beginTransient()).toBe(false);
  expect(() => host.commit("during", host.snapshot().version, box)).toThrow("stale-change-set");
  host.endTransient();
  expect(() => host.commit("old", base.version, box)).toThrow("stale-change-set");
  expect(host.processor.historyLength).toBe(0);
  host.beginTransient();
  host.endTransient(box);
  expect(host.processor.historyLength).toBe(1);
});

test("failed batch validation leaves version/history untouched and subscriber exceptions cannot hide a commit", () => {
  const { host } = fixture();
  const base = host.snapshot();
  expect(() =>
    host.commit("invalid", base.version, [...box, { commandId: "not.registered", arguments: {} }]),
  ).toThrow();
  expect(host.snapshot()).toEqual(base);
  expect(host.processor.historyLength).toBe(0);
  host.subscribe(() => {
    throw new Error("view failure");
  });
  expect(host.commit("valid", base.version, box).document.objects).toHaveLength(1);
  expect(() => host.commit("valid", host.snapshot().version, box)).toThrow("already-applied");
});

test("later edits conservatively qualify earlier application effects instead of claiming they survived", () => {
  const { host, events } = fixture();
  host.commit("original", host.snapshot().version, box);
  host.execute([{ commandId: "document.rename", arguments: { name: "Edited scene" } }]);
  const event = events.at(-1);
  expect(event?.type === "changed" && event.effects).toEqual([{ id: "original", effect: "unknown" }]);
});
test("deleted IDs cannot bind old references after recreation, Undo, or atomic replacement", () => {
  const { host } = fixture();
  host.execute(box);
  const id = host.snapshot().document.objects[0]!.id;
  expect(host.snapshot().objectRevisions?.[id] ?? 0).toBe(0);
  host.execute([{ commandId: "object.delete", arguments: { objectIds: [id] } }, ...box]);
  expect(host.snapshot().document.objects[0]!.id).toBe(id);
  expect(host.snapshot().objectRevisions?.[id]).toBe(1);
  host.execute([{ commandId: "object.rename", arguments: { objectId: id, name: "Renamed" } }]);
  expect(host.snapshot().objectRevisions?.[id]).toBe(1);
  host.execute([{ commandId: "object.delete", arguments: { objectIds: [id] } }]);
  host.undo();
  expect(host.snapshot().objectRevisions?.[id]).toBe(2);
});