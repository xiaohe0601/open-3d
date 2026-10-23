import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { ModelingContractError } from "./commands.ts";
import { queryModelingDocument } from "./queries.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url));
const readDocument = async () => JSON.parse(await readFile(fixturePath, "utf8"));

test("read-only queries return serializable data without exposing or mutating document objects", async () => {
  const document = await readDocument();
  const original = structuredClone(document);

  const hierarchy = queryModelingDocument(document, "scene.getHierarchy");
  const transform = queryModelingDocument(document, "object.getTransform", { objectId: "object-1" });
  const summary = queryModelingDocument(document, "mesh.getSummary", { objectId: "object-1" });
  const selection = queryModelingDocument(document, "selection.get");
  const mode = queryModelingDocument(document, "editor.getMode");

  assert.deepEqual(hierarchy, {
    sceneId: "scene-1",
    items: [{ id: "object-1", name: "Quad", parentId: null, visible: true }],
    nextCursor: null,
  });
  assert.deepEqual(transform, {
    objectId: "object-1",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  });
  assert.deepEqual(summary, {
    objectId: "object-1",
    vertexCount: 4,
    edgeCount: 4,
    faceCount: 1,
    components: [],
    nextCursor: null,
  });
  assert.deepEqual(selection, {
    mode: "face",
    objectIds: ["object-1"],
    componentIds: ["face-1"],
    activeObjectId: "object-1",
  });
  assert.deepEqual(mode, { editor: "mesh", selectionMode: "face" });
  assert.doesNotThrow(() => JSON.stringify([hierarchy, transform, summary, selection, mode]));
  assert.deepEqual(document, original);

  hierarchy.items[0].name = "Changed copy";
  selection.objectIds.push("other");
  assert.deepEqual(document, original);
});

test("hierarchy and component details are bounded and use stable cursors", async () => {
  const document = await readDocument();
  const scene = document.scenes[0];
  for (let index = 2; index <= 6; index += 1) {
    const id = `object-${index}`;
    scene.objectIds.push(id);
    document.objects.push({
      id,
      name: `Object ${index}`,
      transform: { position: [index, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      mesh: null,
      visible: true,
      parentId: null,
    });
  }

  const firstPage = queryModelingDocument(document, "scene.getHierarchy", { limit: 2 });
  const secondPage = queryModelingDocument(document, "scene.getHierarchy", {
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  const componentPage = queryModelingDocument(document, "mesh.getSummary", {
    objectId: "object-1",
    includeComponents: true,
    limit: 3,
  });

  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.nextCursor, "2");
  assert.equal(secondPage.items[0].id, "object-3");
  assert.equal(secondPage.nextCursor, "4");
  assert.equal(componentPage.components.length, 3);
  assert.deepEqual(
    componentPage.components.map(({ kind }) => kind),
    ["vertex", "vertex", "vertex"],
  );
  assert.equal(componentPage.nextCursor, "3");
  assert.throws(
    () => queryModelingDocument(document, "scene.getHierarchy", { limit: 1001 }),
    (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
  );
});

test("missing entities and malformed query input return structured errors", async () => {
  const document = await readDocument();

  assert.throws(
    () => queryModelingDocument(document, "object.getTransform", { objectId: "missing" }),
    (error) =>
      error instanceof ModelingContractError && error.code === "not-found" && error.details.entityId === "missing",
  );
  assert.throws(
    () => queryModelingDocument(document, "scene.getHierarchy", { cursor: "not-an-offset" }),
    (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
  );
});

test("operation eligibility reports current selection and topology blockers without mutation", async () => {
  const document = await readDocument();
  const original = structuredClone(document);
  const valid = queryModelingDocument(document, "operation.getEligibility", {
    commandId: "mesh.insetFaces",
    arguments: { objectId: "object-1", faceIds: ["face-1"], offset: 0.1 },
  });
  const invalid = queryModelingDocument(document, "operation.getEligibility", {
    commandId: "mesh.bevelEdges",
    arguments: { objectId: "object-1", edgeIds: ["edge-1"], width: 0.1, segments: 1 },
  });
  const unknown = queryModelingDocument(document, "operation.getEligibility", {
    commandId: "mesh.notRegistered",
  });

  assert.deepEqual(valid, { eligible: true, blockers: [] });
  assert.equal(invalid.eligible, false);
  assert.equal(invalid.blockers[0].code, "boundary-edge");
  assert.deepEqual(
    unknown.blockers.map(({ code }) => code),
    ["unknown-command"],
  );
  assert.deepEqual(document, original);
});

test("face-region eligibility rejects disconnected selections", async () => {
  const document = await readDocument();
  const mesh = document.objects[0].mesh;
  const duplicateVertexIds = ["vertex-5", "vertex-6", "vertex-7", "vertex-8"];
  const sourceVertices = mesh.vertices.slice(0, 4);
  mesh.vertices.push(
    ...sourceVertices.map((vertex, index) => ({
      id: duplicateVertexIds[index],
      position: [vertex.position[0] + 3, vertex.position[1], vertex.position[2]],
    })),
  );
  mesh.edges.push(
    { id: "edge-5", vertexIds: ["vertex-5", "vertex-6"] },
    { id: "edge-6", vertexIds: ["vertex-6", "vertex-7"] },
    { id: "edge-7", vertexIds: ["vertex-7", "vertex-8"] },
    { id: "edge-8", vertexIds: ["vertex-8", "vertex-5"] },
  );
  mesh.faces.push({
    id: "face-2",
    vertexIds: duplicateVertexIds,
    materialId: "material-1",
  });
  document.selection.componentIds = ["face-1", "face-2"];

  const eligibility = queryModelingDocument(document, "operation.getEligibility", {
    commandId: "mesh.insetFaces",
    arguments: {
      objectId: "object-1",
      faceIds: ["face-1", "face-2"],
      offset: 0.1,
    },
  });

  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.blockers.some(({ code }) => code === "disconnected-selection"));
});