import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deserializeModelingDocument } from "@open-3d/model-core";
import { test } from "vite-plus/test";
import { deserializeNativeProject, NativeProjectError, serializeNativeProject } from "./index.ts";
import { exportGltf, importGltf } from "./gltf.ts";

const fixturePath = (name) => fileURLToPath(new URL(`../../../tests/fixtures/documents/${name}`, import.meta.url));
const readFixture = async (name) => readFile(fixturePath(name), "utf8");
const gltfFixturePath = (name) => fileURLToPath(new URL(`../../../tests/fixtures/gltf/${name}`, import.meta.url));
const modelFixturePath = (name) => fileURLToPath(new URL(`../../../tests/fixtures/documents/${name}`, import.meta.url));

test("opens the current native project fixture and serializes deterministically", async () => {
  const serialized = await readFixture("native-project-v1.json");
  const document = deserializeNativeProject(serialized);
  const saved = serializeNativeProject(document);

  assert.deepEqual(deserializeNativeProject(saved), document);
  assert.equal(serializeNativeProject(deserializeNativeProject(saved)), saved);
});

test("round-trips geometry, hierarchy, transforms, materials, and view settings without browser storage", async () => {
  const source = deserializeNativeProject(await readFixture("native-project-v1.json"));
  const document = structuredClone(source);
  const child = structuredClone(document.objects[0]);
  child.id = "object-child";
  child.name = "Nested child";
  child.parentId = document.objects[0].id;
  child.transform.position = [2, -3, 4];
  child.transform.rotation = [0, 0.3826834324, 0, 0.9238795325];
  child.transform.scale = [2, 0.5, 1.5];
  child.mesh.id = "mesh-child";
  child.mesh.vertices = child.mesh.vertices.map((vertex) => ({ ...vertex, id: `${vertex.id}-child` }));
  child.mesh.edges = child.mesh.edges.map((edge) => ({
    ...edge,
    id: `${edge.id}-child`,
    vertexIds: edge.vertexIds.map((id) => `${id}-child`),
  }));
  child.mesh.faces = child.mesh.faces.map((face) => ({
    ...face,
    id: `${face.id}-child`,
    vertexIds: face.vertexIds.map((id) => `${id}-child`),
  }));
  document.objects.push(child);
  document.scenes[0].objectIds.push(child.id);
  document.workspace = {
    projection: "orthographic",
    cameraPosition: [9, 7, 5],
    cameraTarget: [1, 2, 3],
    cameraRotation: [0.1, 0.2, 0.3, 0.9],
    fieldOfView: 42,
    orthographicScale: 13,
    showGrid: false,
    showAxes: false,
  };

  const serialized = serializeNativeProject(document);
  assert.deepEqual(deserializeNativeProject(serialized), document);
  assert.equal(serializeNativeProject(deserializeNativeProject(serialized)), serialized);
});

test("imports the glTF golden fixture and reports content outside the supported subset", async () => {
  const imported = await importGltf(await readFile(gltfFixturePath("basic.gltf"), "utf8"), "gltf");
  const root = imported.document.objects.find(({ name }) => name === "Root");
  const triangle = imported.document.objects.find(({ name }) => name === "Triangle");
  assert.ok(root);
  assert.ok(triangle);
  assert.equal(triangle.parentId, root.id);
  assert.deepEqual(triangle.transform.position, [0, 0, 2]);
  assert.deepEqual(
    triangle.mesh.vertices.map(({ position }) => position),
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
  );
  assert.deepEqual(imported.document.materials[0], {
    id: "material-1",
    name: "Red metal",
    baseColor: [0.8, 0.1, 0.2, 1],
    metallic: 0.65,
    roughness: 0.25,
  });
  assert.ok(imported.omittedContent.some((item) => item.includes("camera")));
});

test("resolves selected external glTF buffer resources", async () => {
  const source = JSON.parse(await readFile(gltfFixturePath("basic.gltf"), "utf8"));
  const buffer = Uint8Array.from(atob("AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA"), (character) =>
    character.charCodeAt(0),
  );
  source.buffers[0].uri = "mesh-data/triangle.bin";
  const imported = await importGltf(JSON.stringify(source), "gltf", [{ name: "triangle.bin", data: buffer }]);

  assert.equal(imported.document.objects.find(({ name }) => name === "Triangle").mesh.faces.length, 1);
});

test.each(["glb", "gltf"])("round-trips supported scene data through %s", async (format) => {
  const source = deserializeModelingDocument(await readFile(modelFixturePath("valid-v1.json"), "utf8"));
  source.objects.push({
    id: "child-transform",
    name: "Child transform",
    transform: { position: [2, -1, 3], rotation: [0, 0.2, 0, 0.98], scale: [2, 1, 0.5] },
    mesh: null,
    visible: true,
    parentId: source.objects[0].id,
  });
  source.scenes[0].objectIds.push("child-transform");
  const exported = await exportGltf(source, format);
  const imported = await importGltf(exported.data, format);

  assert.equal(imported.document.name, source.name);
  assert.equal(imported.document.objects.length, source.objects.length);
  assert.deepEqual(imported.document.objects[0].transform, source.objects[0].transform);
  assert.equal(imported.document.objects[1].parentId, imported.document.objects[0].id);
  assert.deepEqual(imported.document.objects[1].transform, source.objects[1].transform);
  assert.deepEqual(
    imported.document.objects[0].mesh.vertices.map(({ position }) => position),
    source.objects[0].mesh.vertices.map(({ position }) => position),
  );
  assert.deepEqual(imported.document.materials[0].baseColor, source.materials[0].baseColor);
  assert.equal(imported.document.materials[0].metallic, source.materials[0].metallic);
  assert.equal(imported.document.materials[0].roughness, source.materials[0].roughness);
});

test("migrates the prior native project format without changing its source fixture", async () => {
  const path = fixturePath("native-project-v0.json");
  const sourceBefore = await readFile(path, "utf8");
  const document = deserializeNativeProject(sourceBefore);
  const sourceAfter = await readFile(path, "utf8");

  assert.equal(document.id, "native-project-document");
  assert.deepEqual(JSON.parse(serializeNativeProject(document)), {
    format: "open-3d-project",
    formatVersion: 1,
    document,
  });
  assert.equal(sourceAfter, sourceBefore);
});

test("rejects a future native project version without changing its source fixture", async () => {
  const path = fixturePath("native-project-future.json");
  const sourceBefore = await readFile(path, "utf8");

  assert.throws(
    () => deserializeNativeProject(sourceBefore),
    (error) =>
      error instanceof NativeProjectError &&
      error.code === "unsupported-version" &&
      error.message.includes("version 42"),
  );
  assert.equal(await readFile(path, "utf8"), sourceBefore);
});

test("rejects a failed migration without changing the source payload", () => {
  const source = JSON.stringify({
    format: "open-3d-project",
    formatVersion: 0,
    legacyPayload: { preserved: true },
  });

  assert.throws(
    () => deserializeNativeProject(source),
    (error) =>
      error instanceof NativeProjectError &&
      error.code === "invalid-envelope" &&
      error.message.includes("missing its modelingDocument payload"),
  );
  assert.deepEqual(JSON.parse(source), {
    format: "open-3d-project",
    formatVersion: 0,
    legacyPayload: { preserved: true },
  });
});

test("reports malformed JSON, envelopes, and invalid documents with stable error codes", () => {
  assert.throws(
    () => deserializeNativeProject("{"),
    (error) => error instanceof NativeProjectError && error.code === "malformed-json",
  );
  assert.throws(
    () => deserializeNativeProject(JSON.stringify({ format: "other", formatVersion: 1 })),
    (error) => error instanceof NativeProjectError && error.code === "invalid-envelope",
  );
  assert.throws(
    () => deserializeNativeProject(JSON.stringify({ format: "open-3d-project", formatVersion: 1, document: {} })),
    (error) => error instanceof NativeProjectError && error.code === "invalid-document",
  );
});