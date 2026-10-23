import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  getCommandDescriptor,
  getModelingOperationCatalog,
  getQueryDescriptor,
  ModelingContractError,
  MODELING_CONTRACT_VERSION,
  MODELING_QUERIES,
  validateCommandArguments,
} from "./commands.ts";

const expectedCommandIds = [
  "document.rename",
  "scene.createPrimitive",
  "object.rename",
  "object.duplicate",
  "object.setVisibility",
  "object.delete",
  "object.setTransform",
  "selection.setObjects",
  "selection.setComponents",
  "selection.setMode",
  "mesh.transformComponents",
  "mesh.extrude",
  "mesh.insetFaces",
  "mesh.mergeVertices",
  "mesh.dissolveEdges",
  "mesh.dissolveFaces",
  "mesh.bevelEdges",
  "mesh.loopCut",
  "mesh.recalculateNormals",
  "mesh.flipNormals",
  "workspace.setView",
];

test("versioned catalog exposes every planned UI mutation with schemas and outcomes", () => {
  const catalog = getModelingOperationCatalog();
  const commandIds = catalog.commands.map(({ id }) => id);

  assert.equal(catalog.contractVersion, MODELING_CONTRACT_VERSION);
  assert.deepEqual(commandIds, expectedCommandIds);
  for (const descriptor of catalog.commands) {
    assert.equal(descriptor.kind, "command");
    assert.equal(descriptor.parameters.type, "object");
    assert.ok(Array.isArray(descriptor.preconditions));
    assert.equal(descriptor.result.type, "object");
    assert.ok(descriptor.result.description.length > 0);
  }
  assert.doesNotThrow(() => JSON.stringify(catalog));
});

test("catalog publishes all planned read-only query contracts", () => {
  assert.deepEqual(
    MODELING_QUERIES.map(({ id }) => id),
    [
      "scene.getHierarchy",
      "object.getTransform",
      "mesh.getSummary",
      "selection.get",
      "editor.getMode",
      "operation.getEligibility",
    ],
  );
  assert.equal(getQueryDescriptor("selection.get").kind, "query");
});

test("command argument validation reports stable structured errors", () => {
  assert.doesNotThrow(() =>
    validateCommandArguments("scene.createPrimitive", {
      primitive: "box",
    }),
  );

  assert.throws(
    () =>
      validateCommandArguments("mesh.bevelEdges", {
        objectId: "mesh-object",
        edgeIds: ["edge-1"],
        width: 0,
        segments: 0.5,
        unsupported: true,
      }),
    (error) =>
      error instanceof ModelingContractError &&
      error.code === "invalid-arguments" &&
      error.details.commandId === "mesh.bevelEdges" &&
      error.details.issues.length >= 3,
  );
});

test("unknown operations and incompatible versions fail before execution", () => {
  assert.equal(getCommandDescriptor("object.rename").id, "object.rename");
  assert.throws(
    () => getCommandDescriptor("object.unknown"),
    (error) => error instanceof ModelingContractError && error.code === "unknown-command",
  );
  assert.throws(
    () => getQueryDescriptor("query.unknown"),
    (error) => error instanceof ModelingContractError && error.code === "unknown-query",
  );
  assert.throws(
    () => validateCommandArguments("not-registered", {}, 99),
    (error) => error instanceof ModelingContractError && error.code === "incompatible-contract-version",
  );
});

test("quad loop cut contract requires an interior normalized position", () => {
  for (const position of [0, 1, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        validateCommandArguments("mesh.loopCut", {
          objectId: "object-1",
          edgeId: "edge-1",
          cuts: 1,
          position,
        }),
      (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
    );
  }
  for (const position of [Number.EPSILON, 0.5, 1 - Number.EPSILON]) {
    assert.doesNotThrow(() =>
      validateCommandArguments("mesh.loopCut", {
        objectId: "object-1",
        edgeId: "edge-1",
        cuts: 1,
        position,
      }),
    );
  }
});