import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  createCoreCommandHandlers,
  ModelingCommandProcessor,
  ModelingContractError,
  validateModelingDocument,
} from "./index.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url));
const readDocument = async () => JSON.parse(await readFile(fixturePath, "utf8"));
const makeProcessor = async (document) =>
  new ModelingCommandProcessor(document ?? (await readDocument()), { handlers: createCoreCommandHandlers() });
const execute = (processor, commandId, args) => processor.executeCommand({ commandId, arguments: args });
const currentSelection = (processor) => processor.getDocumentSnapshot().selection;

test("component selection validates IDs and stores them in canonical mesh order", async () => {
  const processor = await makeProcessor();
  const before = processor.getDocumentSnapshot();

  execute(processor, "selection.setComponents", {
    objectId: "object-1",
    mode: "edge",
    componentIds: ["edge-4", "edge-1"],
  });
  assert.deepEqual(currentSelection(processor), {
    mode: "edge",
    objectIds: ["object-1"],
    componentIds: ["edge-1", "edge-4"],
    activeObjectId: "object-1",
  });
  const selected = processor.getDocumentSnapshot();
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), selected);
});

test("component selection rejects duplicate and stale IDs atomically", async () => {
  const processor = await makeProcessor();
  const before = processor.getDocumentSnapshot();
  for (const componentIds of [["edge-1", "edge-1"], ["missing-edge"]]) {
    assert.throws(
      () =>
        execute(processor, "selection.setComponents", {
          objectId: "object-1",
          mode: "edge",
          componentIds,
        }),
      (error) =>
        error instanceof ModelingContractError && ["invalid-arguments", "operation-ineligible"].includes(error.code),
    );
    assert.deepEqual(processor.getDocumentSnapshot(), before);
    assert.equal(processor.historyLength, 0);
  }
});

test("object selection uses stable order and chooses a valid active object", async () => {
  const document = await readDocument();
  document.scenes[0].objectIds.push("object-2");
  document.objects.push({
    ...structuredClone(document.objects[0]),
    id: "object-2",
    name: "Second",
    mesh: null,
  });
  const processor = await makeProcessor(document);

  execute(processor, "selection.setObjects", { objectIds: ["object-2", "object-1"] });
  assert.deepEqual(currentSelection(processor), {
    mode: "object",
    objectIds: ["object-2", "object-1"],
    componentIds: [],
    activeObjectId: "object-1",
  });
  execute(processor, "selection.setObjects", { objectIds: [] });
  assert.deepEqual(currentSelection(processor), {
    mode: "object",
    objectIds: [],
    componentIds: [],
    activeObjectId: null,
  });
});

test("conversion between component modes follows mesh incidence deterministically", async () => {
  const processor = await makeProcessor();
  execute(processor, "selection.setComponents", {
    objectId: "object-1",
    mode: "vertex",
    componentIds: ["vertex-1"],
  });
  execute(processor, "selection.setMode", { mode: "edge", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["edge-1", "edge-4"]);
  execute(processor, "selection.setMode", { mode: "face", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["face-1"]);
  execute(processor, "selection.setMode", { mode: "vertex", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["vertex-1", "vertex-2", "vertex-3", "vertex-4"]);
});

test("edge and face conversion preserves source components and selects their incident elements", async () => {
  const processor = await makeProcessor();
  execute(processor, "selection.setComponents", {
    objectId: "object-1",
    mode: "edge",
    componentIds: ["edge-1"],
  });
  execute(processor, "selection.setMode", { mode: "vertex", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["vertex-1", "vertex-2"]);
  execute(processor, "selection.setMode", { mode: "edge", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["edge-1", "edge-2", "edge-4"]);
  execute(processor, "selection.setMode", { mode: "face", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["face-1"]);
  execute(processor, "selection.setMode", { mode: "edge", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["edge-1", "edge-2", "edge-3", "edge-4"]);
});

test("object-to-component conversion selects all components; component-to-object selects owner", async () => {
  const processor = await makeProcessor();
  execute(processor, "selection.setObjects", { objectIds: ["object-1"] });
  execute(processor, "selection.setMode", { mode: "vertex", conversion: "convert" });
  assert.deepEqual(currentSelection(processor).componentIds, ["vertex-1", "vertex-2", "vertex-3", "vertex-4"]);
  execute(processor, "selection.setMode", { mode: "object", conversion: "convert" });
  assert.deepEqual(currentSelection(processor), {
    mode: "object",
    objectIds: ["object-1"],
    componentIds: [],
    activeObjectId: "object-1",
  });
});

test("clear mode empties selection without leaving invalid component ownership", async () => {
  const processor = await makeProcessor();
  execute(processor, "selection.setMode", { mode: "edge", conversion: "clear" });
  assert.deepEqual(currentSelection(processor), {
    mode: "edge",
    objectIds: ["object-1"],
    componentIds: [],
    activeObjectId: "object-1",
  });
  validateModelingDocument(processor.getDocumentSnapshot());
  execute(processor, "selection.setMode", { mode: "object", conversion: "clear" });
  assert.deepEqual(currentSelection(processor), {
    mode: "object",
    objectIds: [],
    componentIds: [],
    activeObjectId: null,
  });
});

test("component mode rejects a non-mesh active object and failed conversion preserves history", async () => {
  const document = await readDocument();
  document.scenes[0].objectIds.push("object-2");
  document.objects.push({
    ...structuredClone(document.objects[0]),
    id: "object-2",
    name: "Empty",
    mesh: null,
  });
  document.selection = {
    mode: "object",
    objectIds: ["object-2"],
    componentIds: [],
    activeObjectId: "object-2",
  };
  const processor = await makeProcessor(document);
  const before = processor.getDocumentSnapshot();

  assert.throws(
    () => execute(processor, "selection.setMode", { mode: "face", conversion: "convert" }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);
});

test("document validation rejects duplicate and mismatched selection identities", async () => {
  const duplicateObjects = await readDocument();
  duplicateObjects.selection.objectIds = ["object-1", "object-1"];
  assert.throws(() => validateModelingDocument(duplicateObjects));

  const duplicateComponents = await readDocument();
  duplicateComponents.selection.componentIds = ["face-1", "face-1"];
  assert.throws(() => validateModelingDocument(duplicateComponents));

  const mismatchedActive = await readDocument();
  mismatchedActive.selection.activeObjectId = null;
  assert.throws(() => validateModelingDocument(mismatchedActive));
});