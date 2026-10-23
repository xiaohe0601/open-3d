import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { ModelingContractError } from "./commands.ts";
import { ModelingCommandProcessor } from "./processor.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url));
const readDocument = async () => JSON.parse(await readFile(fixturePath, "utf8"));

function renameHandler(document, args) {
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
}

test("a command commits once and undo/redo restores exact document snapshots", async () => {
  const initial = await readDocument();
  const processor = new ModelingCommandProcessor(initial, {
    handlers: { "object.rename": renameHandler },
  });
  initial.objects[0].name = "Changed outside processor";
  const before = processor.getDocumentSnapshot();

  const receipt = processor.executeCommand({
    commandId: "object.rename",
    arguments: { objectId: "object-1", name: "Renamed" },
  });
  const after = processor.getDocumentSnapshot();

  assert.deepEqual(receipt, {
    commandId: "object.rename",
    result: {
      affectedEntityIds: ["object-1"],
      selection: before.selection,
    },
  });
  assert.equal(after.objects[0].name, "Renamed");
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.canUndo, true);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.canRedo, true);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), after);
  assert.equal(processor.undo(), true);
  assert.equal(processor.undo(), false);
});

test("a successful command group creates one history entry and undoes as a unit", async () => {
  const processor = new ModelingCommandProcessor(await readDocument(), {
    handlers: { "object.rename": renameHandler },
  });
  const before = processor.getDocumentSnapshot();

  const receipt = processor.executeGroup([
    { commandId: "object.rename", arguments: { objectId: "object-1", name: "First" } },
    { commandId: "object.rename", arguments: { objectId: "object-1", name: "Final" } },
  ]);

  assert.equal(receipt.commandCount, 2);
  assert.equal(receipt.results.length, 2);
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Final");
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Final");
});

test("failed groups leave document, undo history, and redo history unchanged", async () => {
  const processor = new ModelingCommandProcessor(await readDocument(), {
    handlers: { "object.rename": renameHandler },
  });
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "object.rename",
    arguments: { objectId: "object-1", name: "Committed" },
  });
  const committed = processor.getDocumentSnapshot();
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  const historyLength = processor.historyLength;

  assert.throws(
    () =>
      processor.executeGroup([
        { commandId: "object.rename", arguments: { objectId: "object-1", name: "Staged" } },
        { commandId: "object.rename", arguments: { objectId: "object-missing", name: "Fails precondition" } },
      ]),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, historyLength);
  assert.equal(processor.canRedo, true);
  assert.deepEqual(committed.objects[0].name, "Committed");
});

test("invalid requests, missing handlers, and invalid handler output do not enter history", async () => {
  const noHandler = new ModelingCommandProcessor(await readDocument());
  const before = noHandler.getDocumentSnapshot();
  assert.throws(
    () =>
      noHandler.executeCommand({
        commandId: "object.rename",
        arguments: { objectId: "object-1", name: "No handler" },
      }),
    (error) => error instanceof ModelingContractError && error.code === "command-unavailable",
  );
  assert.throws(
    () =>
      noHandler.executeCommand({
        commandId: "object.rename",
        contractVersion: 99,
        arguments: { objectId: "object-1", name: "Wrong version" },
      }),
    (error) => error instanceof ModelingContractError && error.code === "incompatible-contract-version",
  );
  assert.throws(
    () => noHandler.executeGroup([]),
    (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
  );
  assert.deepEqual(noHandler.getDocumentSnapshot(), before);
  assert.equal(noHandler.historyLength, 0);

  const invalidOutput = new ModelingCommandProcessor(await readDocument(), {
    handlers: {
      "object.rename": (document) => ({
        document: { ...document, activeSceneId: "missing-scene" },
        result: {},
      }),
    },
  });
  assert.throws(
    () =>
      invalidOutput.executeCommand({
        commandId: "object.rename",
        arguments: { objectId: "object-1", name: "Invalid" },
      }),
    (error) =>
      error instanceof ModelingContractError && (error.code === "invalid-document" || error.code === "invalid-result"),
  );
  assert.equal(invalidOutput.historyLength, 0);
  assert.equal(invalidOutput.getDocumentSnapshot().objects[0].name, "Quad");
});

test("new edits clear redo history and history length respects its cap", async () => {
  const processor = new ModelingCommandProcessor(await readDocument(), {
    maxHistory: 1,
    handlers: { "object.rename": renameHandler },
  });
  const rename = (name) =>
    processor.executeCommand({
      commandId: "object.rename",
      arguments: { objectId: "object-1", name },
    });

  rename("One");
  assert.equal(processor.undo(), true);
  assert.equal(processor.canRedo, true);
  rename("Two");
  assert.equal(processor.canRedo, false);
  rename("Three");
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Two");
});