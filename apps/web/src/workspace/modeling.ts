import { ModelingCommandProcessor, createCoreCommandHandlers } from "@open-3d/model-core";
import type { ModelingDocument, ModelingObject } from "@open-3d/model-core";

export type Primitive = "box" | "uv-sphere" | "cylinder";
export type TransformOperation = "translate" | "rotate" | "scale";
export type TransformAxis = 0 | 1 | 2 | null;
export type Vec3 = [number, number, number];
export type MeshOperation =
  | "mesh.extrude"
  | "mesh.insetFaces"
  | "mesh.mergeVertices"
  | "mesh.dissolveEdges"
  | "mesh.dissolveFaces"
  | "mesh.bevelEdges"
  | "mesh.loopCut"
  | "mesh.recalculateNormals"
  | "mesh.flipNormals";

export interface TransformSession {
  source: ModelingDocument;
  values: Vec3;
}

export interface TransformConfiguration {
  operation: TransformOperation | null;
  axis: TransformAxis;
  snap: boolean;
  snapStep: number;
}

export const emptyDocument = (): ModelingDocument => ({
  schemaVersion: 1,
  id: "open-3d-document",
  name: "Untitled project",
  activeSceneId: "scene-main",
  scenes: [{ id: "scene-main", name: "Scene", objectIds: [] }],
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
});

export const meshOperations: [MeshOperation, string][] = [
  ["mesh.extrude", "Extrude"],
  ["mesh.insetFaces", "Inset faces"],
  ["mesh.mergeVertices", "Merge vertices"],
  ["mesh.dissolveEdges", "Dissolve edges"],
  ["mesh.dissolveFaces", "Dissolve faces"],
  ["mesh.bevelEdges", "Bevel edges"],
  ["mesh.loopCut", "Loop cut"],
  ["mesh.recalculateNormals", "Recalculate normals"],
  ["mesh.flipNormals", "Flip normals"],
];

export function createProcessor(document = emptyDocument()): ModelingCommandProcessor {
  return new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
}

export function selectedObject(document: ModelingDocument): ModelingObject | undefined {
  const id = document.selection.activeObjectId;
  return document.objects.find((object) => object.id === id);
}

export function quaternionToEuler([x, y, z, w]: ModelingObject["transform"]["rotation"]): Vec3 {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw];
}

export function eulerToQuaternion([x, y, z]: Vec3): ModelingObject["transform"]["rotation"] {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

export function multiplyQuaternions(
  [ax, ay, az, aw]: ModelingObject["transform"]["rotation"],
  [bx, by, bz, bw]: ModelingObject["transform"]["rotation"],
): ModelingObject["transform"]["rotation"] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function componentPivot(document: ModelingDocument, object: ModelingObject): Vec3 {
  const mesh = object.mesh;
  if (!mesh) return [0, 0, 0];
  const ids = new Set<string>();
  if (document.selection.mode === "vertex") document.selection.componentIds.forEach((id) => ids.add(id));
  if (document.selection.mode === "edge") {
    mesh.edges
      .filter(({ id }) => document.selection.componentIds.includes(id))
      .forEach(({ vertexIds }) => vertexIds.forEach((id) => ids.add(id)));
  }
  if (document.selection.mode === "face") {
    mesh.faces
      .filter(({ id }) => document.selection.componentIds.includes(id))
      .forEach(({ vertexIds }) => vertexIds.forEach((id) => ids.add(id)));
  }
  const vertices = mesh.vertices.filter(({ id }) => ids.has(id));
  if (!vertices.length) return [0, 0, 0];
  return [0, 1, 2].map(
    (axis) => vertices.reduce((sum, vertex) => sum + vertex.position[axis], 0) / vertices.length,
  ) as Vec3;
}

export function createTransformCommand(
  source: ModelingDocument,
  rawValues: Vec3,
  config: TransformConfiguration,
): { commandId: string; arguments: Record<string, unknown> } | null {
  const object = selectedObject(source);
  if (!object || !config.operation) return null;

  const values = [...rawValues] as Vec3;
  if (config.axis !== null) {
    values.forEach((_, axis) => {
      if (axis !== config.axis) values[axis] = config.operation === "scale" ? 1 : 0;
    });
  }
  if (config.snap) {
    const step = config.operation === "rotate" ? (config.snapStep * Math.PI) / 180 : config.snapStep;
    values.forEach((value, axis) => {
      const snapped =
        config.operation === "scale" ? 1 + Math.round((value - 1) / step) * step : Math.round(value / step) * step;
      values[axis] = Number(Math.max(config.operation === "scale" ? 0.01 : -Infinity, snapped).toPrecision(12));
    });
  }

  if (source.selection.mode === "object") {
    const transform = structuredClone(object.transform);
    if (config.operation === "translate") {
      transform.position = transform.position.map((value, axis) => value + values[axis]) as Vec3;
    } else if (config.operation === "rotate") {
      transform.rotation = multiplyQuaternions(transform.rotation, eulerToQuaternion(values));
    } else {
      transform.scale = transform.scale.map((value, axis) => value * values[axis]) as Vec3;
    }
    return { commandId: "object.setTransform", arguments: { objectId: object.id, transform } };
  }

  if (!object.mesh || !source.selection.componentIds.length) return null;
  return {
    commandId: "mesh.transformComponents",
    arguments: {
      objectId: object.id,
      mode: source.selection.mode,
      operation: config.operation,
      value: values,
      pivot: componentPivot(source, object),
    },
  };
}

export function operationArguments(
  document: ModelingDocument,
  operation: MeshOperation,
  values: Record<string, number | string | boolean>,
): Record<string, unknown> {
  const object = selectedObject(document);
  const componentIds = document.selection.componentIds;
  const base = { objectId: object?.id ?? "", mode: document.selection.mode, componentIds };
  switch (operation) {
    case "mesh.extrude":
      return {
        ...base,
        distance: values.distance ?? 1,
        direction: [values.directionX ?? 0, values.directionY ?? 0, values.directionZ ?? 1],
      };
    case "mesh.insetFaces":
      return { objectId: object?.id ?? "", faceIds: componentIds, offset: values.offset ?? 0.1 };
    case "mesh.mergeVertices":
      return { objectId: object?.id ?? "", vertexIds: componentIds, target: values.target ?? "center" };
    case "mesh.dissolveEdges":
      return { objectId: object?.id ?? "", edgeIds: componentIds, preserveBoundary: values.preserveBoundary ?? true };
    case "mesh.dissolveFaces":
      return { objectId: object?.id ?? "", faceIds: componentIds };
    case "mesh.bevelEdges":
      return {
        objectId: object?.id ?? "",
        edgeIds: componentIds,
        width: values.width ?? 0.1,
        segments: values.segments ?? 1,
      };
    case "mesh.loopCut":
      return {
        objectId: object?.id ?? "",
        edgeId: values.edgeId ?? object?.mesh?.edges[0]?.id ?? "",
        cuts: values.cuts ?? 1,
        position: values.position ?? 0.5,
      };
    case "mesh.recalculateNormals":
      return { objectId: object?.id ?? "", scope: "connected-component" };
    case "mesh.flipNormals":
      return { objectId: object?.id ?? "", faceIds: componentIds };
  }
}