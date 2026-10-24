import { expect, test } from "vite-plus/test";
import { createProcessor } from "./modeling";
import { describeSelection } from "./selection-status";

test("describes the actual selected objects, not only the active object", () => {
  const processor = createProcessor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Box" } });
  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "cylinder", name: "Cylinder" },
  });
  const ids = processor.getDocumentSnapshot().objects.map((object) => object.id);
  processor.executeCommand({ commandId: "selection.setObjects", arguments: { objectIds: ids } });
  expect(describeSelection(processor.getDocumentSnapshot())).toEqual({ kind: "objects", names: "Box, Cylinder" });
  processor.executeCommand({ commandId: "selection.setObjects", arguments: { objectIds: [] } });
  expect(describeSelection(processor.getDocumentSnapshot())).toEqual({ kind: "empty" });
});

test("component status names the object and component mode/count, with no stale object selection", () => {
  const processor = createProcessor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Box" } });
  const document = processor.getDocumentSnapshot();
  document.selection = {
    mode: "face",
    objectIds: [document.objects[0]!.id],
    activeObjectId: document.objects[0]!.id,
    componentIds: ["face-1", "face-2"],
  };
  expect(describeSelection(document)).toEqual({ kind: "components", name: "Box", mode: "face", count: 2 });
  document.selection.componentIds = [];
  expect(describeSelection(document)).toEqual({ kind: "empty" });
});