import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vite-plus/test";
import { benchmarkDefinitions, createBenchmarkFixtures, createQuadGrid } from "./scenes.mjs";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("benchmark scenes are deterministic", () => {
  const first = createBenchmarkFixtures();
  const second = createBenchmarkFixtures();

  assert.equal(hash(first), hash(second));
});

test("primitive scene has a stable object count and identity order", () => {
  const { primitiveScene } = createBenchmarkFixtures();

  assert.equal(primitiveScene.objects.length, benchmarkDefinitions.primitiveScene.objectCount);
  assert.equal(primitiveScene.objects[0].id, "box-0001");
  assert.equal(primitiveScene.objects.at(-1).id, "box-0100");
});

test("quad fixtures have predictable vertex and face counts", () => {
  const { editableQuad, denseMesh } = createBenchmarkFixtures();

  assert.equal(editableQuad.vertices.length, 17 * 17);
  assert.equal(editableQuad.faces.length, 16 * 16);
  assert.equal(denseMesh.vertices.length, 129 * 129);
  assert.equal(denseMesh.faces.length, 128 * 128);
  assert.ok(denseMesh.faces.every((face) => face.length === 4));
});

test("grid generator rejects invalid dimensions", () => {
  assert.throws(() => createQuadGrid(0, 2), RangeError);
  assert.throws(() => createQuadGrid(2.5, 2), RangeError);
});

test("interchange fixture covers hierarchy, transforms, geometry, and supported material factors", () => {
  const { interchange } = createBenchmarkFixtures();
  const node = interchange.scene.nodes[0].children[0];
  const primitive = interchange.scene.meshes[0].primitives[0];

  assert.deepEqual(node.translation, [1, 2, 3]);
  assert.equal(primitive.positions.length, 8);
  assert.equal(primitive.indices.length, 36);
  assert.deepEqual(primitive.material.baseColorFactor, [0.8, 0.2, 0.1, 1]);
  assert.equal(primitive.material.metallicFactor, 0.1);
  assert.equal(primitive.material.roughnessFactor, 0.7);
});