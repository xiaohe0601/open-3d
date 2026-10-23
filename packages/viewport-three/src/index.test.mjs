import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Vector3 } from "three";
import { ModelingCommandProcessor, createCoreCommandHandlers, queryModelingDocument } from "@open-3d/model-core";
import {
  ThreeViewport,
  buildDocumentProjection,
  componentIdAt,
  orbitCameraView,
  panCameraView,
  zoomCameraView,
} from "./index.ts";

function makeDocument() {
  const document = {
    schemaVersion: 1,
    id: "doc",
    name: "Viewport test",
    activeSceneId: "scene",
    scenes: [{ id: "scene", name: "Scene", objectIds: [] }],
    objects: [],
    materials: [],
    selection: { mode: "object", objectIds: [], componentIds: [], activeObjectId: null },
    workspace: {
      projection: "perspective",
      cameraPosition: [6, -8, 6],
      cameraTarget: [0, 0, 0],
      cameraRotation: [0, 0, 0, 1],
      fieldOfView: 50,
      orthographicScale: 10,
      showGrid: true,
      showAxes: true,
    },
  };
  const processor = new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Box" } });
  return processor.getDocumentSnapshot();
}

function findDocumentObject(scene, id) {
  let match;
  scene.traverse((object) => {
    if (object.isGroup && object.userData.documentObjectId === id) match = object;
  });
  return match;
}

function documentWithPolygon(points) {
  const document = makeDocument();
  const object = document.objects[0];
  const vertexIds = points.map((_, index) => `polygon-v-${index}`);
  object.mesh = {
    id: "polygon-mesh",
    vertices: points.map((position, index) => ({ id: vertexIds[index], position })),
    edges: vertexIds.map((vertexId, index) => ({
      id: `polygon-e-${index}`,
      vertexIds: [vertexId, vertexIds[(index + 1) % vertexIds.length]],
    })),
    faces: [{ id: "polygon-face", vertexIds, materialId: null }],
  };
  return document;
}

test("projects document geometry, object transforms, grid, and axes", () => {
  const document = makeDocument();
  const projection = buildDocumentProjection(document);
  const objectGroup = findDocumentObject(projection.scene, document.objects[0].id);
  assert.ok(objectGroup);
  assert.deepEqual(objectGroup.position.toArray(), document.objects[0].transform.position);
  assert.ok(projection.scene.children.some((child) => child.type === "GridHelper"));
  assert.ok(projection.scene.getObjectByName("World axes"));
  const surface = objectGroup.children.find((child) => child.isMesh);
  assert.equal(surface.geometry.getAttribute("position").count, 8);
  assert.equal(surface.geometry.index.count, 36);
  projection.dispose();
});

test("preserves triangulation for concave and non-planar polygons", () => {
  const concave = buildDocumentProjection(
    documentWithPolygon([
      [0, 0, 0],
      [2, 0, 0],
      [1, 0.5, 0],
      [2, 2, 0],
      [0, 2, 0],
    ]),
  );
  const concaveSurface = concave.scene.children.find((child) => child.isGroup).children.find((child) => child.isMesh);
  assert.equal(concaveSurface.geometry.index.count, 9);
  assert.equal(concaveSurface.userData.faceIdsByTriangle.length, 3);
  concave.dispose();

  const nonPlanar = buildDocumentProjection(
    documentWithPolygon([
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0.25],
    ]),
  );
  const nonPlanarSurface = nonPlanar.scene.children
    .find((child) => child.isGroup)
    .children.find((child) => child.isMesh);
  assert.equal(nonPlanarSurface.geometry.index.count, 6);
  assert.equal(nonPlanarSurface.userData.faceIdsByTriangle.length, 2);
  nonPlanar.dispose();
});

test("rebuilds deterministic projections and supports projection and standard views", () => {
  const document = makeDocument();
  const first = buildDocumentProjection(document);
  const second = buildDocumentProjection(document);
  assert.equal(findDocumentObject(first.scene, document.objects[0].id).children.length, 2);
  assert.deepEqual(first.camera.position.toArray(), second.camera.position.toArray());
  first.dispose();
  second.dispose();

  const orthographic = buildDocumentProjection(document, { projection: "orthographic", view: "top", aspect: 2 });
  assert.equal(orthographic.camera.type, "OrthographicCamera");
  const viewDistance = Math.hypot(...document.workspace.cameraPosition);
  assert.equal(orthographic.camera.position.z, document.workspace.cameraTarget[2] + viewDistance);
  assert.equal(orthographic.camera.top, 5);
  orthographic.dispose();

  const front = buildDocumentProjection(document, { view: "front" });
  assert.equal(front.camera.type, "PerspectiveCamera");
  assert.equal(front.camera.position.y, document.workspace.cameraTarget[1] - viewDistance);
  front.dispose();
});

test("grid and axis visibility are rebuilt from document settings", () => {
  const document = makeDocument();
  document.workspace.showGrid = false;
  document.workspace.showAxes = false;
  const projection = buildDocumentProjection(document);
  assert.equal(
    projection.scene.children.some((child) => child.type === "GridHelper"),
    false,
  );
  assert.equal(projection.scene.getObjectByName("World axes"), undefined);
  projection.dispose();
});

test("picked stable component IDs commit as the queried core selection", () => {
  const document = makeDocument();
  const processor = new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
  const object = document.objects[0];
  const vertexId = componentIdAt(object, "vertex", 2);
  const edgeId = componentIdAt(object, "edge", 4);
  const faceId = componentIdAt(object, "face", 3);

  for (const [mode, componentId] of [
    ["vertex", vertexId],
    ["edge", edgeId],
    ["face", faceId],
  ]) {
    processor.executeCommand({
      commandId: "selection.setComponents",
      arguments: { objectId: object.id, mode, componentIds: [componentId] },
    });
    const selection = queryModelingDocument(processor.getDocumentSnapshot(), "selection.get", {});
    assert.equal(selection.mode, mode);
    assert.equal(selection.activeObjectId, object.id);
    assert.deepEqual(selection.componentIds, [componentId]);
  }
});

test("orbit, pan, and zoom change only the viewport camera state", () => {
  const document = makeDocument();
  const before = structuredClone(document);
  const target = new Vector3(...document.workspace.cameraTarget);
  const projection = buildDocumentProjection(document, { aspect: 1.5 });
  const initialPosition = projection.camera.position.clone();

  orbitCameraView(projection.camera, target, 42, -18);
  assert.notDeepEqual(projection.camera.position.toArray(), initialPosition.toArray());
  panCameraView(projection.camera, target, 28, 16, 600);
  assert.notDeepEqual(target.toArray(), document.workspace.cameraTarget);
  zoomCameraView(projection.camera, target, -120);
  assert.ok(
    projection.camera.position.distanceTo(target) <
      initialPosition.distanceTo(new Vector3(...document.workspace.cameraTarget)),
  );
  assert.deepEqual(document, before);
  projection.dispose();

  const orthographic = buildDocumentProjection(document, { projection: "orthographic" });
  const zoomBefore = orthographic.camera.zoom;
  zoomCameraView(orthographic.camera, target, -100);
  assert.ok(orthographic.camera.zoom > zoomBefore);
  orthographic.dispose();
});
test("applies viewport appearance without mutating modeling data or materials", () => {
  const document = makeDocument();
  const before = JSON.stringify(document);
  const appearance = { background: "#1b211d", grid: "#353b37", gridMajor: "#66766c", edge: "#b6c5bb" };
  const projection = buildDocumentProjection(document, { appearance });
  assert.equal(projection.scene.background.getHexString(), "1b211d");
  const grid = projection.scene.children.find((child) => child.type === "GridHelper");
  assert.ok(grid);
  assert.equal(JSON.stringify(document), before);
  projection.dispose();
});

test("uses themed neutral edges and vertices without recoloring model materials or selected components", () => {
  const document = makeDocument();
  const object = document.objects[0];
  document.selection = {
    mode: "vertex",
    objectIds: [object.id],
    componentIds: [object.mesh.vertices[0].id],
    activeObjectId: object.id,
  };
  const before = JSON.stringify(document);
  const colors = [];
  for (const appearance of [
    { background: "#fafafa", grid: "#dedede", gridMajor: "#888888", edge: "#525252" },
    { background: "#141414", grid: "#363636", gridMajor: "#7a7a7a", edge: "#c0c0c0" },
  ]) {
    const projection = buildDocumentProjection(document, { appearance });
    try {
      const group = findDocumentObject(projection.scene, object.id);
      const edges = group.children.find((child) => child.isLineSegments);
      const vertices = group.children.find((child) => child.isPoints && child.material.size === 7);
      const selected = group.children.find((child) => child.isPoints && child.material.size === 11);
      assert.equal(edges.material.color.getHexString(), appearance.edge.slice(1));
      assert.equal(vertices.material.color.getHexString(), appearance.edge.slice(1));
      colors.push({
        material: group.children.find((child) => child.isMesh).material.color.getHexString(),
        selection: selected.material.color.getHexString(),
      });
    } finally {
      projection.dispose();
    }
  }
  assert.deepEqual(colors[0], colors[1]);
  assert.equal(JSON.stringify(document), before);
});

test("view shortcut commands reset the camera repeatedly while passive view synchronization remains idempotent", () => {
  const viewport = Object.create(ThreeViewport.prototype);
  const document = makeDocument();
  const before = JSON.stringify(document);
  const resets = [];
  const views = [];
  Object.assign(viewport, {
    document,
    view: "front",
    target: new Vector3(2, 3, 4),
    cameraState: { position: new Vector3(1, 2, 3) },
    rebuild: (reset) => resets.push(reset),
  });
  viewport.setViewChangeHandler((view) => views.push(view));
  viewport.setView("front");
  assert.equal(resets.length, 0);
  viewport.alignView("front");
  viewport.alignView("front");
  viewport.alignView("user");
  assert.deepEqual(resets, [true, true, true]);
  assert.deepEqual(views, ["front", "front", "user"]);
  assert.equal(viewport.cameraState, undefined);
  assert.deepEqual(viewport.target.toArray(), document.workspace.cameraTarget);
  assert.equal(JSON.stringify(document), before);
});

test("orbiting releases a snapped view once and preserves its actual camera across UI synchronization", () => {
  const document = makeDocument();
  const before = JSON.stringify(document);
  const projection = buildDocumentProjection(document, { view: "front" });
  const viewport = Object.create(ThreeViewport.prototype);
  const views = [];
  const resetAttempts = [];
  Object.assign(viewport, {
    document,
    projection,
    view: "front",
    target: new Vector3(...document.workspace.cameraTarget),
    renderer: { render() {} },
    rebuild: (reset) => resetAttempts.push(reset),
  });
  viewport.setViewChangeHandler((view) => views.push(view));
  const start = projection.camera.position.clone();
  viewport.orbit(40, 20);
  viewport.orbit(10, -5);
  const after = projection.camera.position.toArray();
  assert.notDeepEqual(after, start.toArray());
  assert.deepEqual(views, ["user"]);
  assert.deepEqual(viewport.cameraState.position.toArray(), after);
  viewport.setView("user");
  assert.deepEqual(resetAttempts, []);
  assert.deepEqual(projection.camera.position.toArray(), after);
  assert.equal(JSON.stringify(document), before);
  projection.dispose();
});