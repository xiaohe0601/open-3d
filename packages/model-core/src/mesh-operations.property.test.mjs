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
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeQuadDocument(seed, size) {
  const document = structuredClone(fixture);
  document.id = `generated-quad-document-${seed}`;
  document.objects[0].mesh.vertices.forEach((vertex) => {
    vertex.position = vertex.position.map((value) => value * size);
  });
  return document;
}

function makeTriangulatedQuadDocument(seed, size) {
  const document = makeQuadDocument(seed, size);
  const mesh = document.objects[0].mesh;
  mesh.faces = [
    { id: "face-1", vertexIds: ["vertex-1", "vertex-2", "vertex-3"], materialId: "material-1" },
    { id: "face-2", vertexIds: ["vertex-1", "vertex-3", "vertex-4"], materialId: "material-1" },
  ];
  mesh.edges.push({ id: "edge-5", vertexIds: ["vertex-1", "vertex-3"] });
  document.selection.componentIds = ["face-1", "face-2"];
  return document;
}

async function makeBoxDocument(seed, size) {
  const base = makeQuadDocument(seed, size);
  const creator = new ModelingCommandProcessor(base, { handlers: createCoreCommandHandlers() });
  creator.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box", size },
  });
  return creator.getDocumentSnapshot();
}

function createProcessor(document) {
  return new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
}

function assertMeshInvariants(document) {
  validateModelingDocument(document);
  for (const object of document.objects) {
    if (!object.mesh) continue;
    const mesh = object.mesh;
    const vertexIds = new Set(mesh.vertices.map(({ id }) => id));
    const edgeKeys = new Set();
    for (const edge of mesh.edges) {
      assert.ok(vertexIds.has(edge.vertexIds[0]) && vertexIds.has(edge.vertexIds[1]));
      assert.notEqual(edge.vertexIds[0], edge.vertexIds[1]);
      const key = [...edge.vertexIds].sort().join("\0");
      assert.ok(!edgeKeys.has(key), `duplicate edge ${key}`);
      edgeKeys.add(key);
    }
    for (const face of mesh.faces) {
      assert.ok(face.vertexIds.length >= 3);
      assert.equal(new Set(face.vertexIds).size, face.vertexIds.length);
      for (let index = 0; index < face.vertexIds.length; index += 1) {
        const first = face.vertexIds[index];
        const second = face.vertexIds[(index + 1) % face.vertexIds.length];
        assert.ok(edgeKeys.has([first, second].sort().join("\0")), `missing edge ${first}-${second}`);
      }
    }
  }
}

async function generatedValidCases(seed, size, random) {
  const quad = makeQuadDocument(seed, size);
  const triangulated = makeTriangulatedQuadDocument(seed, size);
  const cube = await makeBoxDocument(seed, size);
  const mesh = cube.objects.at(-1).mesh;
  const oneFace = quad.objects[0].mesh.faces[0].id;
  const twoTriangleFaces = triangulated.objects[0].mesh.faces.map(({ id }) => id);
  const firstCubeEdge = mesh.edges[0].id;
  mesh.faces[seed % mesh.faces.length].vertexIds.reverse();
  return [
    {
      id: "mesh.transformComponents",
      document: quad,
      request: {
        commandId: "mesh.transformComponents",
        arguments: {
          objectId: "object-1",
          mode: "face",
          operation: "translate",
          value: [size * random(), 0, size * random()],
        },
      },
    },
    {
      id: "mesh.extrude.vertex",
      document: quad,
      request: {
        commandId: "mesh.extrude",
        arguments: {
          objectId: "object-1",
          mode: "vertex",
          componentIds: ["vertex-1"],
          distance: size * (0.1 + random()),
          direction: [0, 0, 1],
        },
      },
    },
    {
      id: "mesh.extrude.edge",
      document: quad,
      request: {
        commandId: "mesh.extrude",
        arguments: {
          objectId: "object-1",
          mode: "edge",
          componentIds: ["edge-1"],
          distance: size * (0.1 + random()),
          direction: [0, 0, 1],
        },
      },
    },
    {
      id: "mesh.extrude.face",
      document: quad,
      request: {
        commandId: "mesh.extrude",
        arguments: {
          objectId: "object-1",
          mode: "face",
          componentIds: [oneFace],
          distance: size * (0.1 + random()),
          direction: [0, 0, 1],
        },
      },
    },
    {
      id: "mesh.insetFaces",
      document: quad,
      request: {
        commandId: "mesh.insetFaces",
        arguments: { objectId: "object-1", faceIds: [oneFace], offset: size * (0.05 + random() * 0.1) },
      },
    },
    {
      id: "mesh.mergeVertices",
      document: quad,
      request: {
        commandId: "mesh.mergeVertices",
        arguments: {
          objectId: "object-1",
          vertexIds: ["vertex-1", "vertex-2"],
          target: seed % 2 ? "center" : "last-selected",
        },
      },
    },
    {
      id: "mesh.dissolveEdges",
      document: triangulated,
      request: {
        commandId: "mesh.dissolveEdges",
        arguments: { objectId: "object-1", edgeIds: ["edge-5"] },
      },
    },
    {
      id: "mesh.dissolveFaces",
      document: triangulated,
      request: {
        commandId: "mesh.dissolveFaces",
        arguments: { objectId: "object-1", faceIds: twoTriangleFaces },
      },
    },
    {
      id: "mesh.bevelEdges",
      document: cube,
      request: {
        commandId: "mesh.bevelEdges",
        arguments: {
          objectId: cube.objects.at(-1).id,
          edgeIds: [firstCubeEdge],
          width: size * (0.03 + random() * 0.04),
          segments: 1 + Math.floor(random() * 4),
        },
      },
    },
    {
      id: "mesh.loopCut",
      document: cube,
      request: {
        commandId: "mesh.loopCut",
        arguments: {
          objectId: cube.objects.at(-1).id,
          edgeId: firstCubeEdge,
          cuts: 1 + Math.floor(random() * 3),
          position: 0.45 + random() * 0.1,
        },
      },
    },
    {
      id: "mesh.recalculateNormals",
      document: cube,
      request: {
        commandId: "mesh.recalculateNormals",
        arguments: { objectId: cube.objects.at(-1).id, scope: "connected-component" },
      },
    },
    {
      id: "mesh.flipNormals",
      document: quad,
      request: {
        commandId: "mesh.flipNormals",
        arguments: { objectId: "object-1", faceIds: [oneFace] },
      },
    },
  ];
}

test("generated eligible mesh commands preserve invariants, deterministic results, and undo/redo", async () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const random = seededRandom(seed * 7919);
    const size = 0.75 + random() * 2;
    const cases = await generatedValidCases(seed, size, random);
    for (const scenario of cases) {
      const first = createProcessor(scenario.document);
      const second = createProcessor(scenario.document);
      const before = first.getDocumentSnapshot();
      const receipt = first.executeCommand(scenario.request);
      second.executeCommand(scenario.request);
      const committed = first.getDocumentSnapshot();

      assert.equal(receipt.commandId, scenario.request.commandId, `${scenario.id}: command receipt`);
      assert.ok(Array.isArray(receipt.result.affectedEntityIds), `${scenario.id}: affected entity IDs`);
      assertMeshInvariants(committed);
      assert.deepEqual(committed, second.getDocumentSnapshot(), `${scenario.id}: deterministic seed ${seed}`);
      assert.equal(first.historyLength, 1, `${scenario.id}: one history entry`);
      assert.equal(first.undo(), true, `${scenario.id}: undo`);
      assert.deepEqual(first.getDocumentSnapshot(), before, `${scenario.id}: exact undo seed ${seed}`);
      assert.equal(first.redo(), true, `${scenario.id}: redo`);
      assert.deepEqual(first.getDocumentSnapshot(), committed, `${scenario.id}: exact redo seed ${seed}`);
      assert.equal(first.undo(), true, `${scenario.id}: restore generated input`);
    }
  }
});

test("generated ineligible mesh commands fail atomically across the operation catalog", async () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const random = seededRandom(seed * 104729);
    const size = 0.5 + random() * 3;
    const openQuad = makeQuadDocument(seed, size);
    const trianglePair = makeTriangulatedQuadDocument(seed, size);
    const nonManifold = structuredClone(trianglePair);
    const nonManifoldMesh = nonManifold.objects[0].mesh;
    nonManifoldMesh.vertices.push({ id: "vertex-5", position: [0.5, 0.5, 1] });
    nonManifoldMesh.faces.push({
      id: "face-3",
      vertexIds: ["vertex-1", "vertex-3", "vertex-5"],
      materialId: "material-1",
    });
    nonManifoldMesh.edges.push(
      { id: "edge-6", vertexIds: ["vertex-3", "vertex-5"] },
      { id: "edge-7", vertexIds: ["vertex-5", "vertex-1"] },
    );
    const scenarios = [
      {
        id: "mesh.transformComponents",
        document: openQuad,
        request: {
          commandId: "mesh.transformComponents",
          arguments: { objectId: "object-1", mode: "face", operation: "translate", value: [0, Number.NaN, 0] },
        },
      },
      {
        id: "mesh.extrude",
        document: openQuad,
        request: {
          commandId: "mesh.extrude",
          arguments: {
            objectId: "object-1",
            mode: "vertex",
            componentIds: ["vertex-1"],
            distance: 0,
            direction: [0, 0, 1],
          },
        },
      },
      {
        id: "mesh.insetFaces",
        document: openQuad,
        request: {
          commandId: "mesh.insetFaces",
          arguments: { objectId: "object-1", faceIds: ["face-1"], offset: size * 10 },
        },
      },
      {
        id: "mesh.mergeVertices",
        document: openQuad,
        request: {
          commandId: "mesh.mergeVertices",
          arguments: { objectId: "object-1", vertexIds: ["vertex-1"], target: "center" },
        },
      },
      {
        id: "mesh.dissolveEdges",
        document: openQuad,
        request: { commandId: "mesh.dissolveEdges", arguments: { objectId: "object-1", edgeIds: ["edge-1"] } },
      },
      {
        id: "mesh.dissolveFaces",
        document: openQuad,
        request: { commandId: "mesh.dissolveFaces", arguments: { objectId: "object-1", faceIds: ["face-1"] } },
      },
      {
        id: "mesh.bevelEdges",
        document: openQuad,
        request: {
          commandId: "mesh.bevelEdges",
          arguments: { objectId: "object-1", edgeIds: ["edge-1"], width: size * 0.05, segments: 1 },
        },
      },
      {
        id: "mesh.loopCut",
        document: openQuad,
        request: {
          commandId: "mesh.loopCut",
          arguments: { objectId: "object-1", edgeId: "edge-1", cuts: 1, position: 0.5 },
        },
      },
      {
        id: "mesh.recalculateNormals",
        document: openQuad,
        request: {
          commandId: "mesh.recalculateNormals",
          arguments: { objectId: "object-1", scope: "connected-component" },
        },
      },
      {
        id: "mesh.flipNormals",
        document: openQuad,
        request: { commandId: "mesh.flipNormals", arguments: { objectId: "object-1", faceIds: [] } },
      },
      {
        id: "mesh.dissolveEdges.non-manifold",
        document: nonManifold,
        request: { commandId: "mesh.dissolveEdges", arguments: { objectId: "object-1", edgeIds: ["edge-5"] } },
      },
    ];
    for (const scenario of scenarios) {
      const processor = createProcessor(scenario.document);
      const before = processor.getDocumentSnapshot();
      assert.throws(
        () => processor.executeCommand(scenario.request),
        (error) =>
          error instanceof ModelingContractError &&
          (error.code === "operation-ineligible" || error.code === "invalid-arguments"),
        `${scenario.id}: expected rejection for seed ${seed}`,
      );
      assert.deepEqual(processor.getDocumentSnapshot(), before, `${scenario.id}: state unchanged seed ${seed}`);
      assert.equal(processor.historyLength, 0, `${scenario.id}: history unchanged seed ${seed}`);
    }
  }
});