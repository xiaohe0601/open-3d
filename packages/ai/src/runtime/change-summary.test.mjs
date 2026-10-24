import { expect, test } from "vite-plus/test";
import { createCoreCommandHandlers, ModelingCommandProcessor } from "@open-3d/model-core";
import { summarizeObjectChanges } from "./change-summary.ts";
const emptyDocument = () => ({
  schemaVersion: 1,
  id: "same-document-id",
  name: "Scene",
  activeSceneId: "scene",
  scenes: [{ id: "scene", name: "Scene", objectIds: [] }],
  objects: [],
  materials: [],
  selection: { mode: "object", objectIds: [], componentIds: [], activeObjectId: null },
  workspace: {
    projection: "perspective",
    cameraPosition: [6, -8, 6],
    cameraTarget: [0, 0, 0],
    cameraRotation: [0, 0, 0, 1],
    fieldOfView: 50,
    orthographicScale: 10,
    showGrid: true,
    showAxes: true,
  },
});

test("whole-batch summary derives created, renamed and deleted objects from validated snapshots", () => {
  const processor = new ModelingCommandProcessor(emptyDocument(), { handlers: createCoreCommandHandlers() });
  processor.executeGroup([
    { commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Original" } },
    { commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Removed" } },
  ]);
  const base = processor.getDocumentSnapshot();
  processor.executeGroup([
    { commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "New" } },
    { commandId: "object.rename", arguments: { objectId: "object-1", name: "Renamed" } },
    { commandId: "object.delete", arguments: { objectIds: ["object-2"] } },
  ]);
  expect(summarizeObjectChanges(base, processor.getDocumentSnapshot())).toEqual([
    { id: "object-1", name: "Renamed", previousName: "Original", kind: "updated" },
    { id: "object-3", name: "New", kind: "created" },
    { id: "object-2", name: "Removed", kind: "deleted" },
  ]);
  processor.undo();
  expect(processor.getDocumentSnapshot()).toEqual(base);
});