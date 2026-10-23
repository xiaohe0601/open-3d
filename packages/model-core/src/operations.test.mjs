import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  createCoreCommandHandlers,
  ModelingCommandProcessor,
  ModelingContractError,
  queryModelingDocument,
  validateModelingDocument,
} from "./index.ts";

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/documents/valid-v1.json", import.meta.url));
const readDocument = async () => JSON.parse(await readFile(fixturePath, "utf8"));
const processorFor = async (document) =>
  new ModelingCommandProcessor(document ?? (await readDocument()), { handlers: createCoreCommandHandlers() });

test("project rename is structured, undoable and preserves geometry and previous history", async () => {
  const processor = await processorFor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({ commandId: "document.rename", arguments: { name: "  Desk study  " } });
  assert.deepEqual(processor.getDocumentSnapshot(), { ...before, name: "Desk study" });
  assert.equal(processor.historyLength, 2);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.equal(processor.getDocumentSnapshot().name, "Desk study");
  assert.equal(processor.undo(), true);
  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects.length, before.objects.length - 1);
});

test("blank project rename fails atomically without changing document or history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  for (const name of ["", " ", "\n\t"]) {
    assert.throws(
      () => processor.executeCommand({ commandId: "document.rename", arguments: { name } }),
      (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
    );
    assert.deepEqual(processor.getDocumentSnapshot(), before);
    assert.equal(processor.historyLength, 0);
  }
});

const assertClosedManifold = (mesh) => {
  const incidence = new Map();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const pair = [face.vertexIds[index], face.vertexIds[(index + 1) % face.vertexIds.length]].sort((first, second) =>
        first.localeCompare(second),
      );
      const key = pair.join("\0");
      incidence.set(key, (incidence.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...incidence.values()].every((count) => count === 2));
};

const signedMeshVolume = (mesh) => {
  const positions = new Map(mesh.vertices.map(({ id, position }) => [id, position]));
  let volume = 0;
  for (const face of mesh.faces) {
    const origin = positions.get(face.vertexIds[0]);
    for (let index = 1; index < face.vertexIds.length - 1; index += 1) {
      const a = positions.get(face.vertexIds[index]).map((value, axis) => value - origin[axis]);
      const b = positions.get(face.vertexIds[index + 1]).map((value, axis) => value - origin[axis]);
      const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      volume += (origin[0] * cross[0] + origin[1] * cross[1] + origin[2] * cross[2]) / 6;
    }
  }
  return volume;
};

const triangulatedQuad = async () => {
  const document = await readDocument();
  const mesh = document.objects[0].mesh;
  mesh.faces = [
    { id: "face-1", vertexIds: ["vertex-1", "vertex-2", "vertex-3"], materialId: "material-1" },
    { id: "face-2", vertexIds: ["vertex-1", "vertex-3", "vertex-4"], materialId: "material-1" },
  ];
  mesh.edges.push({ id: "edge-5", vertexIds: ["vertex-1", "vertex-3"] });
  document.selection = {
    mode: "face",
    objectIds: ["object-1"],
    componentIds: ["face-1", "face-2"],
    activeObjectId: "object-1",
  };
  return document;
};

test("primitive commands create deterministic, valid topology and select the new object", async () => {
  for (const { primitive, expected } of [
    { primitive: "box", expected: { vertices: 8, edges: 12, faces: 6 } },
    { primitive: "uv-sphere", expected: { vertices: 114, edges: 240, faces: 128 } },
    { primitive: "cylinder", expected: { vertices: 32, edges: 48, faces: 18 } },
  ]) {
    const first = await processorFor();
    const second = await processorFor();
    const request = {
      commandId: "scene.createPrimitive",
      arguments: { primitive, size: 2, segments: 16 },
    };
    const receipt = first.executeCommand(request);
    second.executeCommand(request);
    const result = first.getDocumentSnapshot();
    const created = result.objects.at(-1);

    assert.deepEqual(result, second.getDocumentSnapshot(), `${primitive} output must be deterministic`);
    assert.equal(created.name, primitive);
    assert.equal(created.mesh.vertices.length, expected.vertices);
    assert.equal(created.mesh.edges.length, expected.edges);
    assert.equal(created.mesh.faces.length, expected.faces);
    assert.deepEqual(result.scenes[0].objectIds.at(-1), created.id);
    assert.deepEqual(result.selection, {
      mode: "object",
      objectIds: [created.id],
      componentIds: [],
      activeObjectId: created.id,
    });
    assert.deepEqual(receipt.result.affectedEntityIds, [created.id]);
    validateModelingDocument(result);
  }
});

test("primitive IDs avoid collisions and create is one undoable edit", async () => {
  const document = await readDocument();
  document.objects[0].id = "object-1";
  const processor = await processorFor(document);
  const before = processor.getDocumentSnapshot();

  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box" },
  });
  const after = processor.getDocumentSnapshot();
  assert.equal(after.objects.at(-1).id, "object-2");
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), after);
});

test("primitive parameter failures are atomic", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  for (const args of [
    { primitive: "cone" },
    { primitive: "box", size: 0 },
    { primitive: "cylinder", segments: 2 },
    { primitive: "uv-sphere", segments: 257 },
  ]) {
    assert.throws(
      () => processor.executeCommand({ commandId: "scene.createPrimitive", arguments: args }),
      (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
    );
    assert.deepEqual(processor.getDocumentSnapshot(), before);
    assert.equal(processor.historyLength, 0);
  }
});

test("hierarchy commands rename, duplicate, toggle visibility, and delete with undoable selection cleanup", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();

  processor.executeCommand({ commandId: "object.rename", arguments: { objectId: "object-1", name: "Renamed" } });
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Renamed");
  processor.executeCommand({ commandId: "object.duplicate", arguments: { objectId: "object-1", offset: [2, 0, 0] } });
  let document = processor.getDocumentSnapshot();
  const duplicate = document.objects[1];
  assert.equal(duplicate.name, "Renamed copy");
  assert.deepEqual(duplicate.transform.position, [2, 0, 0]);
  assert.notEqual(duplicate.mesh.id, document.objects[0].mesh.id);
  assert.equal(
    new Set([
      ...duplicate.mesh.vertices.map(({ id }) => id),
      ...duplicate.mesh.edges.map(({ id }) => id),
      ...duplicate.mesh.faces.map(({ id }) => id),
    ]).size,
    duplicate.mesh.vertices.length + duplicate.mesh.edges.length + duplicate.mesh.faces.length,
  );
  assert.deepEqual(document.selection.objectIds, [duplicate.id]);

  processor.executeCommand({
    commandId: "object.setVisibility",
    arguments: { objectIds: [duplicate.id], visible: false },
  });
  assert.equal(processor.getDocumentSnapshot().objects[1].visible, false);
  processor.executeCommand({ commandId: "object.delete", arguments: { objectIds: [duplicate.id] } });
  document = processor.getDocumentSnapshot();
  assert.deepEqual(document.scenes[0].objectIds, ["object-1"]);
  assert.deepEqual(document.selection, { mode: "object", objectIds: [], componentIds: [], activeObjectId: null });

  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects.length, 2);
  assert.equal(processor.getDocumentSnapshot().selection.activeObjectId, duplicate.id);
  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects[1].visible, true);
  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects.length, 1);
  assert.equal(processor.undo(), true);
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Quad");
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.equal(processor.getDocumentSnapshot().objects[0].name, "Renamed");
});

test("hierarchy command failures do not mutate the document or history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  for (const request of [
    { commandId: "object.rename", arguments: { objectId: "missing", name: "Missing" } },
    { commandId: "object.duplicate", arguments: { objectId: "missing" } },
    { commandId: "object.setVisibility", arguments: { objectIds: ["missing"], visible: false } },
    { commandId: "object.delete", arguments: { objectIds: ["missing"] } },
  ]) {
    assert.throws(() => processor.executeCommand(request), ModelingContractError);
    assert.deepEqual(processor.getDocumentSnapshot(), before);
    assert.equal(processor.historyLength, 0);
  }
});

test("object transforms commit exactly and undo/redo in one step", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  const transform = {
    position: [3, -2, 5],
    rotation: [0, 0.3826834324, 0, 0.9238795325],
    scale: [2, 0.5, 1.25],
  };
  processor.executeCommand({
    commandId: "object.setTransform",
    arguments: { objectId: "object-1", transform },
  });
  const after = processor.getDocumentSnapshot();

  assert.deepEqual(after.objects[0].transform, transform);
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), after);
});

test("component translation, rotation, and scale preserve topology and are undoable", async () => {
  const processor = await processorFor();
  const original = processor.getDocumentSnapshot();
  const mesh = original.objects[0].mesh;

  processor.executeCommand({
    commandId: "mesh.transformComponents",
    arguments: { objectId: "object-1", mode: "face", operation: "translate", value: [0, 0, 2] },
  });
  const translated = processor.getDocumentSnapshot();
  assert.deepEqual(
    translated.objects[0].mesh.vertices.map(({ position }) => position),
    mesh.vertices.map(({ position }) => [position[0], position[1], position[2] + 2]),
  );
  assert.deepEqual(translated.objects[0].mesh.edges, mesh.edges);
  assert.deepEqual(translated.objects[0].mesh.faces, mesh.faces);
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), original);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), translated);

  processor.executeCommand({
    commandId: "mesh.transformComponents",
    arguments: { objectId: "object-1", mode: "face", operation: "rotate", value: [0, 0, Math.PI / 2] },
  });
  const rotated = processor.getDocumentSnapshot();
  assert.deepEqual(
    rotated.objects[0].mesh.vertices[0].position.map((value) => Math.round(value * 1e8) / 1e8),
    [1, 0, 2],
  );

  processor.executeCommand({
    commandId: "mesh.transformComponents",
    arguments: { objectId: "object-1", mode: "face", operation: "scale", value: [2, 1, 1] },
  });
  const scaled = processor.getDocumentSnapshot();
  assert.equal(scaled.objects[0].mesh.vertices[0].position[0], 1.5);
  assert.deepEqual(scaled.objects[0].mesh.edges, mesh.edges);
  assert.deepEqual(scaled.objects[0].mesh.faces, mesh.faces);
});

test("invalid component transforms and missing objects do not enter history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.transformComponents",
        arguments: { objectId: "object-1", mode: "face", operation: "translate", value: [0, Infinity, 0] },
      }),
    (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
  );
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "object.setTransform",
        arguments: {
          objectId: "missing",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);
});

test("single-vertex extrusion adds one stable edge and follows normalized direction", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.extrude",
    arguments: {
      objectId: "object-1",
      mode: "vertex",
      componentIds: ["vertex-1"],
      distance: 2,
      direction: [0, 0, 4],
    },
  });
  const after = processor.getDocumentSnapshot();
  const mesh = after.objects[0].mesh;
  assert.equal(mesh.vertices.length, 5);
  assert.equal(mesh.edges.length, 5);
  assert.equal(mesh.faces.length, 1);
  assert.deepEqual(mesh.vertices.at(-1).position, [0, 0, 2]);
  assert.deepEqual(mesh.edges.at(-1).vertexIds, ["vertex-1", mesh.vertices.at(-1).id]);
  assert.deepEqual(after.selection, {
    mode: "edge",
    objectIds: ["object-1"],
    componentIds: [mesh.edges.at(-1).id],
    activeObjectId: "object-1",
  });
  validateModelingDocument(after);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), after);
});

test("open boundary edge-chain extrusion creates deterministic bridge quads", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.extrude",
    arguments: {
      objectId: "object-1",
      mode: "edge",
      componentIds: ["edge-1", "edge-2"],
      distance: 1,
      direction: [0, 0, 1],
    },
  });
  const result = processor.getDocumentSnapshot();
  const mesh = result.objects[0].mesh;
  assert.equal(mesh.vertices.length, 7);
  assert.equal(mesh.edges.length, 9);
  assert.equal(mesh.faces.length, 3);
  assert.deepEqual(result.selection.mode, "face");
  assert.equal(result.selection.componentIds.length, 2);
  assert.ok(result.selection.componentIds.every((id) => mesh.faces.some((face) => face.id === id)));
  validateModelingDocument(result);
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), result);
  assert.deepEqual(
    mesh.faces.slice(-2).map(({ vertexIds }) => vertexIds),
    [
      ["vertex-2", "vertex-1", mesh.vertices[4].id, mesh.vertices[5].id],
      ["vertex-3", "vertex-2", mesh.vertices[5].id, mesh.vertices[6].id],
    ],
  );
});

test("face extrusion creates a cap and side faces while preserving an open source boundary", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.extrude",
    arguments: {
      objectId: "object-1",
      mode: "face",
      componentIds: ["face-1"],
      distance: 1,
      direction: [0, 0, 3],
    },
  });
  const result = processor.getDocumentSnapshot();
  const mesh = result.objects[0].mesh;
  assert.equal(mesh.vertices.length, 8);
  assert.equal(mesh.edges.length, 12);
  assert.equal(mesh.faces.length, 6);
  assert.deepEqual(
    mesh.vertices.slice(4).map(({ position }) => position),
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
  );
  assert.equal(result.selection.componentIds.length, 1);
  assert.deepEqual(
    mesh.faces[1].vertexIds,
    mesh.vertices.slice(4).map(({ id }) => id),
  );
  validateModelingDocument(result);
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), result);
});

test("face extrusion replaces selected faces on closed meshes without introducing non-manifold edges", async () => {
  const processor = await processorFor();
  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box" },
  });
  const document = processor.getDocumentSnapshot();
  const object = document.objects.at(-1);
  const topFace = object.mesh.faces.find((face) =>
    face.vertexIds.every((vertexId) => object.mesh.vertices.find(({ id }) => id === vertexId).position[2] === 1),
  );
  processor.executeCommand({
    commandId: "selection.setComponents",
    arguments: { objectId: object.id, mode: "face", componentIds: [topFace.id] },
  });

  processor.executeCommand({
    commandId: "mesh.extrude",
    arguments: {
      objectId: object.id,
      mode: "face",
      componentIds: [topFace.id],
      distance: 1,
      direction: [0, 0, 1],
    },
  });

  const result = processor.getDocumentSnapshot();
  const extruded = result.objects.find(({ id }) => id === object.id).mesh;
  assert.equal(extruded.vertices.length, 12);
  assert.equal(extruded.edges.length, 20);
  assert.equal(extruded.faces.length, 10);
  assertClosedManifold(extruded);
  assert.equal(
    queryModelingDocument(result, "operation.getEligibility", {
      commandId: "mesh.extrude",
      arguments: {
        objectId: object.id,
        mode: "face",
        componentIds: result.selection.componentIds,
        distance: 1,
        direction: [0, 0, 1],
      },
    }).eligible,
    true,
  );
});

test("face inset builds a ring and inner face and rejects collapsing offsets atomically", async () => {
  const processor = await processorFor();
  const beforeInset = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.insetFaces",
    arguments: { objectId: "object-1", faceIds: ["face-1"], offset: 0.1 },
  });
  const result = processor.getDocumentSnapshot();
  const mesh = result.objects[0].mesh;
  assert.equal(mesh.vertices.length, 8);
  assert.equal(mesh.edges.length, 12);
  assert.equal(mesh.faces.length, 5);
  assert.deepEqual(result.selection.componentIds, ["face-1"]);
  assert.deepEqual(
    mesh.faces[0].vertexIds,
    mesh.vertices.slice(4).map(({ id }) => id),
  );
  validateModelingDocument(result);
  assert.equal(processor.historyLength, 1);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), beforeInset);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), result);

  const processor2 = await processorFor();
  const before = processor2.getDocumentSnapshot();
  const eligibility = queryModelingDocument(before, "operation.getEligibility", {
    commandId: "mesh.insetFaces",
    arguments: { objectId: "object-1", faceIds: ["face-1"], offset: 0.6 },
  });
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.blockers.some(({ code }) => code === "inset-collapses-face"));
  assert.throws(
    () =>
      processor2.executeCommand({
        commandId: "mesh.insetFaces",
        arguments: { objectId: "object-1", faceIds: ["face-1"], offset: 0.6 },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor2.getDocumentSnapshot(), before);
  assert.equal(processor2.historyLength, 0);
});

test("ineligible edge chains, vertex sets, and zero extrusion vectors are rejected without history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  const invalidRequests = [
    { mode: "vertex", componentIds: ["vertex-1", "vertex-2"], distance: 1, direction: [0, 0, 1] },
    { mode: "edge", componentIds: ["edge-1", "edge-2", "edge-3", "edge-4"], distance: 1, direction: [0, 0, 1] },
    { mode: "face", componentIds: ["face-1"], distance: 1, direction: [0, 0, 0] },
  ];
  for (const args of invalidRequests) {
    assert.throws(
      () => processor.executeCommand({ commandId: "mesh.extrude", arguments: { objectId: "object-1", ...args } }),
      (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
    );
    assert.deepEqual(processor.getDocumentSnapshot(), before);
    assert.equal(processor.historyLength, 0);
  }

  const branched = await readDocument();
  branched.objects[0].mesh.vertices.push({ id: "vertex-5", position: [-1, 0, 0] });
  branched.objects[0].mesh.edges.push({ id: "edge-5", vertexIds: ["vertex-1", "vertex-5"] });
  const branchProcessor = await processorFor(branched);
  assert.throws(
    () =>
      branchProcessor.executeCommand({
        commandId: "mesh.extrude",
        arguments: {
          objectId: "object-1",
          mode: "edge",
          componentIds: ["edge-1", "edge-4", "edge-5"],
          distance: 1,
          direction: [0, 0, 1],
        },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.equal(branchProcessor.historyLength, 0);

  const triangulated = await readDocument();
  triangulated.objects[0].mesh.faces = [
    { id: "face-1a", vertexIds: ["vertex-1", "vertex-2", "vertex-3"], materialId: "material-1" },
    { id: "face-1b", vertexIds: ["vertex-1", "vertex-3", "vertex-4"], materialId: "material-1" },
  ];
  triangulated.objects[0].mesh.edges.push({
    id: "edge-diagonal",
    vertexIds: ["vertex-1", "vertex-3"],
  });
  triangulated.selection = {
    mode: "edge",
    objectIds: ["object-1"],
    componentIds: ["edge-diagonal"],
    activeObjectId: "object-1",
  };
  const interiorProcessor = await processorFor(triangulated);
  assert.throws(
    () =>
      interiorProcessor.executeCommand({
        commandId: "mesh.extrude",
        arguments: {
          objectId: "object-1",
          mode: "edge",
          componentIds: ["edge-diagonal"],
          distance: 1,
          direction: [0, 0, 1],
        },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
});

test("vertex merge supports center and last-selected targets, removes collapsed elements, and is undoable", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.mergeVertices",
    arguments: { objectId: "object-1", vertexIds: ["vertex-1", "vertex-2"], target: "center" },
  });
  const centered = processor.getDocumentSnapshot();
  const mesh = centered.objects[0].mesh;
  assert.equal(mesh.vertices.length, 3);
  assert.equal(mesh.edges.length, 3);
  assert.equal(mesh.faces.length, 1);
  assert.deepEqual(mesh.vertices.find(({ id }) => id === "vertex-1").position, [0.5, 0, 0]);
  assert.deepEqual(mesh.faces[0].vertexIds, ["vertex-1", "vertex-3", "vertex-4"]);
  assert.deepEqual(centered.selection.componentIds, ["vertex-1"]);
  validateModelingDocument(centered);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), centered);

  const lastSelected = await processorFor();
  lastSelected.executeCommand({
    commandId: "mesh.mergeVertices",
    arguments: { objectId: "object-1", vertexIds: ["vertex-1", "vertex-2"], target: "last-selected" },
  });
  assert.deepEqual(
    lastSelected.getDocumentSnapshot().objects[0].mesh.vertices.find(({ id }) => id === "vertex-2").position,
    [1, 0, 0],
  );
  assert.deepEqual(lastSelected.getDocumentSnapshot().selection.componentIds, ["vertex-2"]);
});

test("vertex merge rejects repeated non-adjacent face vertices atomically", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.mergeVertices",
        arguments: { objectId: "object-1", vertexIds: ["vertex-1", "vertex-3"], target: "center" },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);
});

test("edge dissolve merges an eligible interior pair and restores through history", async () => {
  const processor = await processorFor(await triangulatedQuad());
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({
    commandId: "mesh.dissolveEdges",
    arguments: { objectId: "object-1", edgeIds: ["edge-5"] },
  });
  const dissolved = processor.getDocumentSnapshot();
  const mesh = dissolved.objects[0].mesh;
  assert.equal(mesh.faces.length, 1);
  assert.equal(mesh.edges.length, 4);
  assert.deepEqual(mesh.faces[0].vertexIds, ["vertex-1", "vertex-2", "vertex-3", "vertex-4"]);
  assert.deepEqual(dissolved.selection.componentIds, ["face-1"]);
  validateModelingDocument(dissolved);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), dissolved);
});

test("face dissolve merges eligible selected regions and rejects invalid selections atomically", async () => {
  const processor = await processorFor(await triangulatedQuad());
  processor.executeCommand({
    commandId: "mesh.dissolveFaces",
    arguments: { objectId: "object-1", faceIds: ["face-1", "face-2"] },
  });
  const dissolved = processor.getDocumentSnapshot();
  assert.equal(dissolved.objects[0].mesh.faces.length, 1);
  assert.equal(dissolved.objects[0].mesh.edges.length, 4);
  assert.deepEqual(dissolved.selection.componentIds, ["face-1"]);
  validateModelingDocument(dissolved);

  const invalidCases = [];
  invalidCases.push({ document: await readDocument(), faceIds: ["face-1"] });
  const mixedMaterials = await triangulatedQuad();
  mixedMaterials.objects[0].mesh.faces[1].materialId = null;
  invalidCases.push({ document: mixedMaterials, faceIds: ["face-1", "face-2"] });
  for (const { document, faceIds } of invalidCases) {
    const invalidProcessor = await processorFor(document);
    const before = invalidProcessor.getDocumentSnapshot();
    assert.throws(
      () =>
        invalidProcessor.executeCommand({
          commandId: "mesh.dissolveFaces",
          arguments: { objectId: "object-1", faceIds },
        }),
      (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
    );
    assert.deepEqual(invalidProcessor.getDocumentSnapshot(), before);
    assert.equal(invalidProcessor.historyLength, 0);
  }
});

test("edge dissolve rejects boundary edges and preserves document and history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.dissolveEdges",
        arguments: { objectId: "object-1", edgeIds: ["edge-1"] },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);
});

test("dissolve rejects a self-intersecting merged boundary atomically", async () => {
  const document = await triangulatedQuad();
  document.objects[0].mesh.vertices[1].position = [1, 1, 0];
  document.objects[0].mesh.vertices[2].position = [0, 1, 0];
  document.objects[0].mesh.vertices[3].position = [1, 0, 0];
  const processor = await processorFor(document);
  const before = processor.getDocumentSnapshot();
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.dissolveEdges",
        arguments: { objectId: "object-1", edgeIds: ["edge-5"] },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);
});

test("isolated cube-edge bevel creates segmented faces and restores through history", async () => {
  const processor = await processorFor();
  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box" },
  });
  const before = processor.getDocumentSnapshot();
  const cube = before.objects.at(-1);
  const edge = cube.mesh.edges[0];
  const eligibility = queryModelingDocument(before, "operation.getEligibility", {
    commandId: "mesh.bevelEdges",
    arguments: { objectId: cube.id, edgeIds: [edge.id], width: 0.1, segments: 2 },
  });
  assert.deepEqual(eligibility, { eligible: true, blockers: [] });

  processor.executeCommand({
    commandId: "mesh.bevelEdges",
    arguments: { objectId: cube.id, edgeIds: [edge.id], width: 0.1, segments: 2 },
  });
  const result = processor.getDocumentSnapshot();
  const beveled = result.objects.at(-1).mesh;
  assert.equal(beveled.vertices.length, cube.mesh.vertices.length + 6);
  assert.equal(beveled.faces.length, cube.mesh.faces.length + 2);
  assert.equal(result.selection.mode, "face");
  assert.equal(result.selection.componentIds.length, 2);
  assert.ok(result.selection.componentIds.every((id) => beveled.faces.some((face) => face.id === id)));
  assertClosedManifold(beveled);
  validateModelingDocument(result);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), result);
});

test("bevel rejects boundary and competing selected edges atomically", async () => {
  const boundaryProcessor = await processorFor();
  const beforeBoundary = boundaryProcessor.getDocumentSnapshot();
  assert.throws(
    () =>
      boundaryProcessor.executeCommand({
        commandId: "mesh.bevelEdges",
        arguments: { objectId: "object-1", edgeIds: ["edge-1"], width: 0.1, segments: 1 },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(boundaryProcessor.getDocumentSnapshot(), beforeBoundary);
  assert.equal(boundaryProcessor.historyLength, 0);

  const processor = await processorFor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const before = processor.getDocumentSnapshot();
  const cube = before.objects.at(-1);
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.bevelEdges",
        arguments: {
          objectId: cube.id,
          edgeIds: [cube.mesh.edges[0].id, cube.mesh.edges[1].id],
          width: 0.1,
          segments: 1,
        },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 1);
});

test("closed quad loop cut inserts deterministic cuts and selects new loop edges", async () => {
  const processor = await processorFor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const before = processor.getDocumentSnapshot();
  const cube = before.objects.at(-1);
  const edge = cube.mesh.edges[0];
  const eligibility = queryModelingDocument(before, "operation.getEligibility", {
    commandId: "mesh.loopCut",
    arguments: { objectId: cube.id, edgeId: edge.id, cuts: 2, position: 0.5 },
  });
  assert.deepEqual(eligibility, { eligible: true, blockers: [] });

  processor.executeCommand({
    commandId: "mesh.loopCut",
    arguments: { objectId: cube.id, edgeId: edge.id, cuts: 2, position: 0.5 },
  });
  const result = processor.getDocumentSnapshot();
  const cutMesh = result.objects.at(-1).mesh;
  assert.equal(cutMesh.faces.length, cube.mesh.faces.length + 8);
  assert.equal(cutMesh.vertices.length, cube.mesh.vertices.length + 8);
  assert.equal(result.selection.mode, "edge");
  assert.equal(result.selection.componentIds.length, 8);
  assert.ok(result.selection.componentIds.every((id) => cutMesh.edges.some((candidate) => candidate.id === id)));
  assertClosedManifold(cutMesh);
  validateModelingDocument(result);
  assert.equal(processor.undo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.redo(), true);
  assert.deepEqual(processor.getDocumentSnapshot(), result);
});

test("quad loop cut rejects open, unsupported, and endpoint positions atomically", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  assert.throws(
    () =>
      processor.executeCommand({
        commandId: "mesh.loopCut",
        arguments: { objectId: "object-1", edgeId: "edge-1", cuts: 1, position: 0.5 },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);

  for (const position of [0, 1]) {
    assert.throws(
      () =>
        processor.executeCommand({
          commandId: "mesh.loopCut",
          arguments: { objectId: "object-1", edgeId: "edge-1", cuts: 1, position },
        }),
      (error) => error instanceof ModelingContractError && error.code === "invalid-arguments",
    );
  }
  assert.deepEqual(processor.getDocumentSnapshot(), before);
  assert.equal(processor.historyLength, 0);

  const closedProcessor = await processorFor();
  closedProcessor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const closedDocument = closedProcessor.getDocumentSnapshot();
  const cube = closedDocument.objects.at(-1);
  const outOfRange = queryModelingDocument(closedDocument, "operation.getEligibility", {
    commandId: "mesh.loopCut",
    arguments: { objectId: cube.id, edgeId: cube.mesh.edges[0].id, cuts: 2, position: 0.95 },
  });
  assert.equal(outOfRange.eligible, false);
  assert.ok(outOfRange.blockers.some(({ code }) => code === "loop-cut-out-of-range"));
});

test("normal recalculation repairs inconsistent winding and points a closed component outward", async () => {
  const processor = await processorFor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const before = processor.getDocumentSnapshot();
  const cube = before.objects.at(-1);
  const mesh = cube.mesh;
  mesh.faces[0].vertexIds.reverse();
  for (const face of mesh.faces) face.vertexIds.reverse();
  const inconsistent = new ModelingCommandProcessor(before, { handlers: createCoreCommandHandlers() });
  const input = inconsistent.getDocumentSnapshot();

  const eligibility = queryModelingDocument(input, "operation.getEligibility", {
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: cube.id, scope: "connected-component" },
  });
  assert.deepEqual(eligibility, { eligible: true, blockers: [] });
  inconsistent.executeCommand({
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: cube.id, scope: "connected-component" },
  });
  const result = inconsistent.getDocumentSnapshot();
  const recalculated = result.objects.at(-1).mesh;

  assertClosedManifold(recalculated);
  assert.ok(signedMeshVolume(recalculated) > 0);
  assert.equal(result.selection.mode, input.selection.mode);
  assert.deepEqual(result.selection, input.selection);
  assert.equal(inconsistent.historyLength, 1);
  assert.equal(inconsistent.undo(), true);
  assert.deepEqual(inconsistent.getDocumentSnapshot(), input);
  assert.equal(inconsistent.redo(), true);
  assert.deepEqual(inconsistent.getDocumentSnapshot(), result);
});

test("normal recalculation uses the selected face to target one disconnected component", async () => {
  const processor = await processorFor();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const document = processor.getDocumentSnapshot();
  const cube = document.objects.at(-1);
  const mesh = cube.mesh;
  const componentFaces = structuredClone(mesh.faces);
  const faceOffset = mesh.faces.length;
  const duplicateVertices = mesh.vertices.map((vertex, index) => ({
    ...structuredClone(vertex),
    id: `duplicate-vertex-${index}`,
    position: [vertex.position[0] + 4, ...vertex.position.slice(1)],
  }));
  const faceIdMap = new Map(componentFaces.map((face, index) => [face.id, `duplicate-face-${index}`]));
  const vertexIdMap = new Map(mesh.vertices.map((vertex, index) => [vertex.id, duplicateVertices[index].id]));
  mesh.vertices.push(...duplicateVertices);
  mesh.faces.push(
    ...componentFaces.map((face) => ({
      ...face,
      id: faceIdMap.get(face.id),
      vertexIds: face.vertexIds.map((id) => vertexIdMap.get(id)),
    })),
  );
  mesh.edges.push(
    ...mesh.edges.map((edge, index) => ({
      ...structuredClone(edge),
      id: `duplicate-edge-${index}`,
      vertexIds: edge.vertexIds.map((id) => vertexIdMap.get(id)),
    })),
  );
  mesh.faces[faceOffset].vertexIds.reverse();
  document.selection = {
    mode: "face",
    objectIds: [cube.id],
    componentIds: [mesh.faces[faceOffset].id],
    activeObjectId: cube.id,
  };
  const selectedProcessor = new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
  const before = selectedProcessor.getDocumentSnapshot();
  const eligibility = queryModelingDocument(before, "operation.getEligibility", {
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: cube.id, scope: "connected-component" },
  });
  assert.deepEqual(eligibility, { eligible: true, blockers: [] });
  selectedProcessor.executeCommand({
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: cube.id, scope: "connected-component" },
  });
  const after = selectedProcessor.getDocumentSnapshot();
  assert.ok(signedMeshVolume({ ...mesh, faces: after.objects.at(-1).mesh.faces.slice(faceOffset) }) > 0);
  assert.deepEqual(
    after.objects.at(-1).mesh.faces.slice(0, faceOffset),
    before.objects.at(-1).mesh.faces.slice(0, faceOffset),
  );
});

test("flipping selected normals reverses winding without changing topology and supports history", async () => {
  const processor = await processorFor();
  const before = processor.getDocumentSnapshot();
  const face = before.objects[0].mesh.faces[0];
  before.selection = {
    mode: "face",
    objectIds: ["object-1"],
    componentIds: [face.id],
    activeObjectId: "object-1",
  };
  const selectedProcessor = new ModelingCommandProcessor(before, { handlers: createCoreCommandHandlers() });
  const input = selectedProcessor.getDocumentSnapshot();
  const meshBefore = input.objects[0].mesh;
  selectedProcessor.executeCommand({
    commandId: "mesh.flipNormals",
    arguments: { objectId: "object-1", faceIds: [face.id] },
  });
  const result = selectedProcessor.getDocumentSnapshot();
  const meshAfter = result.objects[0].mesh;

  assert.deepEqual(meshAfter.vertices, meshBefore.vertices);
  assert.deepEqual(meshAfter.edges, meshBefore.edges);
  assert.deepEqual(meshAfter.faces[0].vertexIds, [...meshBefore.faces[0].vertexIds].reverse());
  assert.deepEqual(result.selection, input.selection);
  assert.equal(selectedProcessor.undo(), true);
  assert.deepEqual(selectedProcessor.getDocumentSnapshot(), input);
  assert.equal(selectedProcessor.redo(), true);
  assert.deepEqual(selectedProcessor.getDocumentSnapshot(), result);
});

test("normal operations reject open, degenerate, and ambiguous components atomically", async () => {
  const openDocument = await readDocument();
  const openProcessor = await processorFor(openDocument);
  const openBefore = openProcessor.getDocumentSnapshot();
  const openEligibility = queryModelingDocument(openBefore, "operation.getEligibility", {
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: "object-1", scope: "connected-component" },
  });
  assert.equal(openEligibility.eligible, false);
  assert.ok(openEligibility.blockers.some(({ code }) => code === "boundary-edge"));
  assert.throws(
    () =>
      openProcessor.executeCommand({
        commandId: "mesh.recalculateNormals",
        arguments: { objectId: "object-1", scope: "connected-component" },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(openProcessor.getDocumentSnapshot(), openBefore);
  assert.equal(openProcessor.historyLength, 0);

  const degenerateProcessor = await processorFor();
  degenerateProcessor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const degenerate = degenerateProcessor.getDocumentSnapshot();
  const degenerateCube = degenerate.objects.at(-1);
  const degenerateFace = degenerateCube.mesh.faces[0];
  const collinearPositions = [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [3, 0, 0],
  ];
  degenerateFace.vertexIds.forEach((id, index) => {
    degenerateCube.mesh.vertices.find((vertex) => vertex.id === id).position = collinearPositions[index];
  });
  const invalidProcessor = new ModelingCommandProcessor(degenerate, { handlers: createCoreCommandHandlers() });
  const invalidBefore = invalidProcessor.getDocumentSnapshot();
  assert.throws(
    () =>
      invalidProcessor.executeCommand({
        commandId: "mesh.recalculateNormals",
        arguments: { objectId: degenerateCube.id, scope: "connected-component" },
      }),
    (error) => error instanceof ModelingContractError && error.code === "operation-ineligible",
  );
  assert.deepEqual(invalidProcessor.getDocumentSnapshot(), invalidBefore);
  assert.equal(invalidProcessor.historyLength, 0);

  const disconnectedProcessor = await processorFor();
  disconnectedProcessor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const disconnected = disconnectedProcessor.getDocumentSnapshot();
  const disconnectedCube = disconnected.objects.at(-1);
  const originalMesh = disconnectedCube.mesh;
  const vertexRemap = new Map(originalMesh.vertices.map((vertex, index) => [vertex.id, `island-${index}`]));
  originalMesh.vertices.push(
    ...originalMesh.vertices.map((vertex) => ({
      ...structuredClone(vertex),
      id: vertexRemap.get(vertex.id),
      position: [vertex.position[0] + 4, ...vertex.position.slice(1)],
    })),
  );
  originalMesh.faces.push(
    ...originalMesh.faces.map((face, index) => ({
      ...structuredClone(face),
      id: `island-face-${index}`,
      vertexIds: face.vertexIds.map((id) => vertexRemap.get(id)),
    })),
  );
  originalMesh.edges.push(
    ...originalMesh.edges.map((edge, index) => ({
      ...structuredClone(edge),
      id: `island-edge-${index}`,
      vertexIds: edge.vertexIds.map((id) => vertexRemap.get(id)),
    })),
  );
  const ambiguousProcessor = new ModelingCommandProcessor(disconnected, { handlers: createCoreCommandHandlers() });
  const ambiguousBefore = ambiguousProcessor.getDocumentSnapshot();
  const ambiguousEligibility = queryModelingDocument(ambiguousBefore, "operation.getEligibility", {
    commandId: "mesh.recalculateNormals",
    arguments: { objectId: disconnectedCube.id, scope: "connected-component" },
  });
  assert.equal(ambiguousEligibility.eligible, false);
  assert.ok(ambiguousEligibility.blockers.some(({ code }) => code === "ambiguous-component"));
  assert.deepEqual(ambiguousProcessor.getDocumentSnapshot(), ambiguousBefore);
  assert.equal(ambiguousProcessor.historyLength, 0);
});