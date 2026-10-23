import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getModelingOperationCatalog,
  ModelingCommandProcessor,
  ModelingContractError,
  queryModelingDocument,
} from "@open-3d/model-core";

const fixture = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url), "utf8"),
);
const catalog = getModelingOperationCatalog();
assert.equal(catalog.contractVersion, 1);
assert.ok(catalog.commands.some(({ id }) => id === "object.rename"));

const hierarchy = queryModelingDocument(fixture, "scene.getHierarchy", { limit: 10 });
assert.equal(hierarchy.items[0].id, "object-1");

const renameHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object) throw new ModelingContractError("not-found", "Object not found.");
  object.name = args.name;
  return {
    document,
    result: {
      affectedEntityIds: [object.id],
      selection: structuredClone(document.selection),
    },
  };
};
const processor = new ModelingCommandProcessor(fixture, {
  handlers: { "object.rename": renameHandler },
});
const before = processor.getDocumentSnapshot();
processor.executeCommand({
  commandId: "object.rename",
  arguments: { objectId: "object-1", name: "Example rename" },
});
assert.equal(processor.getDocumentSnapshot().objects[0].name, "Example rename");
assert.equal(processor.undo(), true);
assert.deepEqual(processor.getDocumentSnapshot(), before);
assert.equal(processor.redo(), true);
assert.equal(processor.getDocumentSnapshot().objects[0].name, "Example rename");

console.log(`Core API example passed (contract v${catalog.contractVersion}).`);