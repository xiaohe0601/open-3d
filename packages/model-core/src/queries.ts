import {
  getCommandDescriptor,
  ModelingContractError,
  validateCommandArguments,
  validateQueryArguments,
} from "./commands.ts";
import type { ModelingDocument, ModelingObject, MeshEdge, MeshFace, MeshVertex, Vec3 } from "./document.ts";
import { validateModelingDocument } from "./document.ts";
import {
  analyzeBevelEdge,
  analyzeDissolveRegion,
  analyzeInset,
  analyzeNormalRecalculation,
  analyzeQuadLoop,
  connectedFaceGroups,
  edgeIncidence,
  meshEdgeKey,
  normalizedDirection,
} from "./mesh-topology.ts";

const DEFAULT_PAGE_SIZE = 100;
const DEGENERATE_AREA_EPSILON = 1e-12;
const PLANARITY_EPSILON = 1e-6;

export interface QueryBlocker {
  code: string;
  message: string;
}

export interface OperationEligibility {
  eligible: boolean;
  blockers: QueryBlocker[];
}

export interface HierarchyQueryResult {
  sceneId: string;
  items: Array<{ id: string; name: string; parentId: string | null; visible: boolean }>;
  nextCursor: string | null;
}

export interface TransformQueryResult {
  objectId: string;
  transform: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
}

export interface MeshSummaryQueryResult {
  objectId: string;
  vertexCount: number;
  edgeCount: number;
  faceCount: number;
  components: Array<{ id: string; kind: ComponentKind }>;
  nextCursor: string | null;
}

export interface SelectionQueryResult {
  mode: ModelingDocument["selection"]["mode"];
  objectIds: string[];
  componentIds: string[];
  activeObjectId: string | null;
}

export interface EditorModeQueryResult {
  editor: "object" | "mesh";
  selectionMode: ModelingDocument["selection"]["mode"];
}

export type ModelingQueryResult =
  | HierarchyQueryResult
  | TransformQueryResult
  | MeshSummaryQueryResult
  | SelectionQueryResult
  | EditorModeQueryResult
  | OperationEligibility;

type ComponentKind = "vertex" | "edge" | "face";
type QueryRecord = Record<string, unknown>;

function record(value: unknown): QueryRecord {
  return value as QueryRecord;
}

function parseCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new ModelingContractError("invalid-arguments", "Query cursor must be a non-negative integer string.", {
      path: "$.arguments.cursor",
    });
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new ModelingContractError("invalid-arguments", "Query cursor is outside the supported range.", {
      path: "$.arguments.cursor",
    });
  }
  return offset;
}

function pageSize(value: unknown): number {
  return value === undefined ? DEFAULT_PAGE_SIZE : (value as number);
}

function activeScene(document: ModelingDocument, sceneId?: string) {
  const targetId = sceneId ?? document.activeSceneId;
  const scene = document.scenes.find((item) => item.id === targetId);
  if (!scene) {
    throw new ModelingContractError("not-found", `Scene "${targetId}" was not found.`, {
      entityType: "scene",
      entityId: targetId,
    });
  }
  return scene;
}

function findObject(document: ModelingDocument, objectId: string): ModelingObject {
  const scene = activeScene(document);
  if (!scene.objectIds.includes(objectId)) {
    throw new ModelingContractError("not-found", `Object "${objectId}" was not found in the active scene.`, {
      entityType: "object",
      entityId: objectId,
      sceneId: scene.id,
    });
  }
  const object = document.objects.find((item) => item.id === objectId);
  if (!object) {
    throw new ModelingContractError("not-found", `Object "${objectId}" was not found.`, {
      entityType: "object",
      entityId: objectId,
    });
  }
  return object;
}

function meshObject(
  document: ModelingDocument,
  objectId: string,
): ModelingObject & { mesh: NonNullable<ModelingObject["mesh"]> } {
  const object = findObject(document, objectId);
  if (!object.mesh) {
    throw new ModelingContractError("not-found", `Object "${objectId}" has no editable mesh.`, {
      entityType: "mesh",
      entityId: objectId,
    });
  }
  return object as ModelingObject & { mesh: NonNullable<ModelingObject["mesh"]> };
}

function copyTransform<T extends ModelingObject>(object: T) {
  return {
    position: [...object.transform.position] as [number, number, number],
    rotation: [...object.transform.rotation] as [number, number, number, number],
    scale: [...object.transform.scale] as [number, number, number],
  };
}

function idOffsetArgument(value: unknown): number {
  return parseCursor(value);
}

function faceEdgeKey(firstId: string, secondId: string): string {
  return meshEdgeKey(firstId, secondId);
}

function faceEdgeIncidence(mesh: NonNullable<ModelingObject["mesh"]>): Map<string, number> {
  const incidence = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const start = face.vertexIds[index];
      const end = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = faceEdgeKey(start, end);
      incidence.set(key, (incidence.get(key) ?? 0) + 1);
    }
  }
  return incidence;
}

function faceArea(face: MeshFace, vertices: Map<string, MeshVertex>): number {
  const points = face.vertexIds.map((id) => vertices.get(id)!.position);
  const origin = points[0];
  let twiceArea = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index].map((value, axis) => value - origin[axis]);
    const b = points[index + 1].map((value, axis) => value - origin[axis]);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    twiceArea += Math.hypot(...cross);
  }
  return twiceArea / 2;
}

function faceIsPlanar(face: MeshFace, vertices: Map<string, MeshVertex>): boolean {
  const points = face.vertexIds.map((id) => vertices.get(id)!.position);
  const origin = points[0];
  let normal: number[] | undefined;
  for (let first = 1; first < points.length - 1 && !normal; first += 1) {
    const a = points[first].map((value, axis) => value - origin[axis]);
    const b = points[first + 1].map((value, axis) => value - origin[axis]);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (Math.hypot(...cross) > DEGENERATE_AREA_EPSILON) normal = cross;
  }
  if (!normal) return false;
  const magnitude = Math.hypot(...normal);
  return points.every((point) => {
    const delta = point.map((value, axis) => value - origin[axis]);
    const distance = Math.abs(delta.reduce((sum, value, axis) => sum + value * normal![axis], 0)) / magnitude;
    return distance <= PLANARITY_EPSILON;
  });
}

function componentPage(
  mesh: NonNullable<ModelingObject["mesh"]>,
  offset: number,
  limit: number,
): Array<{ id: string; kind: ComponentKind }> {
  const collections: Array<{ kind: ComponentKind; values: readonly { id: string }[] }> = [
    { kind: "vertex", values: mesh.vertices },
    { kind: "edge", values: mesh.edges },
    { kind: "face", values: mesh.faces },
  ];
  const page: Array<{ id: string; kind: ComponentKind }> = [];
  let base = 0;
  for (const collection of collections) {
    const start = Math.max(0, offset - base);
    const end = Math.min(collection.values.length, offset + limit - base);
    for (let index = start; index < end; index += 1) {
      page.push({ id: collection.values[index].id, kind: collection.kind });
    }
    base += collection.values.length;
    if (page.length >= limit || base >= offset + limit) break;
  }
  return page;
}

function selectedComponentIds(document: ModelingDocument, args: QueryRecord, kind: ComponentKind): string[] {
  const argKey = kind === "vertex" ? "vertexIds" : kind === "edge" ? "edgeIds" : "faceIds";
  const explicit = args[argKey] ?? args.componentIds;
  if (Array.isArray(explicit)) return explicit as string[];
  if (document.selection.mode === kind) return [...document.selection.componentIds];
  return [];
}

function selectedTargetObjectId(document: ModelingDocument, args: QueryRecord): string | undefined {
  if (typeof args.objectId === "string") return args.objectId;
  return document.selection.activeObjectId ?? document.selection.objectIds[0];
}

function addBlocker(blockers: QueryBlocker[], code: string, message: string): void {
  if (!blockers.some((item) => item.code === code && item.message === message)) {
    blockers.push({ code, message });
  }
}

function connectedFaceSelection(faces: readonly MeshFace[], selectedIds: readonly string[]): boolean {
  if (selectedIds.length < 2) return true;
  const selected = new Set(selectedIds);
  const adjacency = new Map<string, Set<string>>();
  const byEdge = new Map<string, string[]>();
  for (const face of faces) {
    if (!selected.has(face.id)) continue;
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const key = faceEdgeKey(face.vertexIds[index], face.vertexIds[(index + 1) % face.vertexIds.length]);
      const sharing = byEdge.get(key) ?? [];
      sharing.push(face.id);
      byEdge.set(key, sharing);
    }
  }
  for (const sharing of byEdge.values()) {
    for (const faceId of sharing) {
      const neighbors = adjacency.get(faceId) ?? new Set<string>();
      for (const neighbor of sharing) if (neighbor !== faceId) neighbors.add(neighbor);
      adjacency.set(faceId, neighbors);
    }
  }
  const visited = new Set<string>();
  const pending = [selectedIds[0]];
  while (pending.length > 0) {
    const faceId = pending.pop()!;
    if (visited.has(faceId)) continue;
    visited.add(faceId);
    pending.push(...(adjacency.get(faceId) ?? []));
  }
  return visited.size === selected.size;
}

function eligibilityForCommand(document: ModelingDocument, commandId: string, args: QueryRecord): OperationEligibility {
  const blockers: QueryBlocker[] = [];
  let descriptor;
  try {
    descriptor = getCommandDescriptor(commandId);
  } catch (error) {
    if (error instanceof ModelingContractError && error.code === "unknown-command") {
      return { eligible: false, blockers: [{ code: error.code, message: error.message }] };
    }
    throw error;
  }
  if (Object.keys(args).length > 0) {
    try {
      validateCommandArguments(commandId, args);
    } catch (error) {
      if (error instanceof ModelingContractError && error.code === "invalid-arguments") {
        return {
          eligible: false,
          blockers: [
            {
              code: error.code,
              message: error.message,
            },
          ],
        };
      }
      throw error;
    }
  }

  if (commandId === "document.rename" || commandId === "scene.createPrimitive") return { eligible: true, blockers };
  const objectIds = Array.isArray(args.objectIds)
    ? (args.objectIds as string[])
    : typeof args.objectId === "string"
      ? [args.objectId]
      : selectedTargetObjectId(document, args)
        ? [selectedTargetObjectId(document, args)!]
        : [...document.selection.objectIds];
  const scene = activeScene(document);
  for (const id of objectIds) {
    if (!scene.objectIds.includes(id)) addBlocker(blockers, "not-found", `Object "${id}" is not in the active scene.`);
  }
  if (commandId.startsWith("object.") || commandId === "selection.setObjects") {
    if (commandId === "object.rename" && !args.objectId && objectIds.length === 0) {
      addBlocker(blockers, "selection-empty", "Select an object or provide objectId.");
    }
    return { eligible: blockers.length === 0, blockers };
  }
  if (commandId === "selection.setComponents") {
    const selectionMode = args.mode;
    if (selectionMode !== "vertex" && selectionMode !== "edge" && selectionMode !== "face") {
      addBlocker(blockers, "invalid-selection-mode", "Select vertex, edge, or face mode.");
    } else {
      const targetId = selectedTargetObjectId(document, args);
      if (!targetId) {
        addBlocker(blockers, "selection-empty", "Select a mesh object or provide objectId.");
      } else {
        try {
          const target = meshObject(document, targetId);
          const ids = selectedComponentIds(document, args, selectionMode);
          const components =
            selectionMode === "vertex"
              ? target.mesh.vertices
              : selectionMode === "edge"
                ? target.mesh.edges
                : target.mesh.faces;
          const available = new Set(components.map(({ id }) => id));
          if (ids.some((id) => !available.has(id))) {
            addBlocker(blockers, "not-found", "One or more selected component IDs do not exist on the target mesh.");
          }
        } catch (error) {
          if (error instanceof ModelingContractError) addBlocker(blockers, error.code, error.message);
          else throw error;
        }
      }
    }
    return { eligible: blockers.length === 0, blockers };
  }
  if (commandId === "selection.setMode") return { eligible: true, blockers };
  if (commandId === "workspace.setView") return { eligible: true, blockers };

  const objectId = selectedTargetObjectId(document, args);
  if (!objectId) {
    addBlocker(blockers, "selection-empty", "Select a mesh object or provide objectId.");
    return { eligible: false, blockers };
  }
  let object: ModelingObject & { mesh: NonNullable<ModelingObject["mesh"]> };
  try {
    object = meshObject(document, objectId);
  } catch (error) {
    if (error instanceof ModelingContractError) {
      addBlocker(blockers, error.code, error.message);
      return { eligible: false, blockers };
    }
    throw error;
  }
  const mesh = object.mesh;
  const vertices = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex]));
  const edges = new Map(mesh.edges.map((edge) => [edge.id, edge]));
  const faces = new Map(mesh.faces.map((face) => [face.id, face]));
  const idsByKind = {
    vertex: new Set(vertices.keys()),
    edge: new Set(edges.keys()),
    face: new Set(faces.keys()),
  };
  const selected: Record<ComponentKind, string[]> = {
    vertex: selectedComponentIds(document, args, "vertex"),
    edge: selectedComponentIds(document, args, "edge"),
    face: selectedComponentIds(document, args, "face"),
  };
  const requestedMode = args.mode;
  const commandKind: ComponentKind | undefined =
    commandId === "mesh.mergeVertices"
      ? "vertex"
      : commandId === "mesh.dissolveEdges" || commandId === "mesh.bevelEdges"
        ? "edge"
        : commandId === "mesh.insetFaces" || commandId === "mesh.dissolveFaces" || commandId === "mesh.flipNormals"
          ? "face"
          : commandId === "mesh.extrude" &&
              (requestedMode === "vertex" || requestedMode === "edge" || requestedMode === "face")
            ? requestedMode
            : undefined;
  const kind =
    commandId === "mesh.transformComponents" &&
    (requestedMode === "vertex" || requestedMode === "edge" || requestedMode === "face")
      ? requestedMode
      : commandKind;
  if (kind) {
    const ids =
      selected[kind].length > 0
        ? selected[kind]
        : document.selection.mode === kind
          ? document.selection.componentIds
          : [];
    const minimum = commandId === "mesh.mergeVertices" ? 2 : 1;
    if (ids.length < minimum) {
      addBlocker(
        blockers,
        "selection-too-small",
        `Select at least ${minimum} ${kind} component${minimum === 1 ? "" : "s"}.`,
      );
    }
    if (ids.some((id) => !idsByKind[kind].has(id))) {
      addBlocker(blockers, "not-found", `One or more selected ${kind} component IDs do not exist on the target mesh.`);
    }
    if (new Set(ids).size !== ids.length) {
      addBlocker(blockers, "duplicate-selection", `Selected ${kind} component IDs must be unique.`);
    }
  }

  const incidence = faceEdgeIncidence(mesh);
  const selectedFaces = selected.face.map((id) => faces.get(id)).filter((face): face is MeshFace => Boolean(face));
  const selectedEdges = selected.edge.map((id) => edges.get(id)).filter((edge): edge is MeshEdge => Boolean(edge));

  if (commandId === "mesh.extrude") {
    if (args.distance === 0) addBlocker(blockers, "zero-distance", "Extrusion distance must be non-zero.");
    if (!Array.isArray(args.direction) || !normalizedDirection(args.direction as Vec3)) {
      addBlocker(blockers, "zero-direction", "Extrusion direction must be a non-zero vector.");
    }
    if (requestedMode === "vertex" && selected.vertex.length !== 1) {
      addBlocker(blockers, "selection-too-large", "Vertex extrusion requires exactly one selected vertex.");
    } else if (requestedMode === "edge") {
      if (selectedEdges.some((edge) => (incidence.get(faceEdgeKey(edge.vertexIds[0], edge.vertexIds[1])) ?? 0) !== 1)) {
        addBlocker(
          blockers,
          "not-boundary-edge",
          "Edge extrusion supports boundary edges incident to exactly one face.",
        );
      }
      const degree = new Map<string, number>();
      const adjacency = new Map<string, Set<string>>();
      for (const edge of selectedEdges) {
        const [first, second] = edge.vertexIds;
        degree.set(first, (degree.get(first) ?? 0) + 1);
        degree.set(second, (degree.get(second) ?? 0) + 1);
        const neighbors = adjacency.get(first) ?? new Set<string>();
        neighbors.add(second);
        adjacency.set(first, neighbors);
        const reverse = adjacency.get(second) ?? new Set<string>();
        reverse.add(first);
        adjacency.set(second, reverse);
      }
      if ([...degree.values()].some((count) => count > 2)) {
        addBlocker(blockers, "branched-selection", "Selected edges must form a non-branching chain.");
      } else if ([...degree.values()].filter((count) => count === 1).length !== 2) {
        addBlocker(blockers, "closed-selection", "Selected edges must form one open chain, not a closed loop.");
      } else if (selectedEdges.length > 0) {
        const visited = new Set<string>();
        const pending = [selectedEdges[0].vertexIds[0]];
        while (pending.length > 0) {
          const vertexId = pending.pop()!;
          if (visited.has(vertexId)) continue;
          visited.add(vertexId);
          pending.push(...(adjacency.get(vertexId) ?? []));
        }
        if (visited.size !== degree.size) {
          addBlocker(blockers, "disconnected-selection", "Selected edges must form one connected chain.");
        }
      }
    } else if (requestedMode === "face") {
      if (
        !connectedFaceSelection(
          mesh.faces,
          selectedFaces.map(({ id }) => id),
        )
      ) {
        addBlocker(blockers, "disconnected-selection", "Selected faces must form one connected region.");
      }
      if ([...incidence.values()].some((count) => count > 2)) {
        addBlocker(blockers, "non-manifold-edge", "Extrusion is not supported on a mesh with non-manifold edges.");
      }
    }
  }
  if (commandId === "mesh.insetFaces") {
    if (
      !connectedFaceSelection(
        mesh.faces,
        selectedFaces.map(({ id }) => id),
      )
    ) {
      addBlocker(blockers, "disconnected-selection", "Selected faces must form one connected region.");
    }
    if (selectedFaces.some((face) => faceArea(face, vertices) <= DEGENERATE_AREA_EPSILON)) {
      addBlocker(blockers, "degenerate-face", "Selected faces must have positive area.");
    }
    if (selectedFaces.some((face) => !faceIsPlanar(face, vertices))) {
      addBlocker(blockers, "non-planar-region", "Selected faces must be planar.");
    }
    const inset = analyzeInset(mesh, selectedFaces, args.offset as number);
    if (!inset.eligible) {
      const code =
        inset.reason === "inset-collapses-face"
          ? "inset-collapses-face"
          : inset.reason === "non-planar-region"
            ? "non-planar-region"
            : inset.reason === "degenerate-face"
              ? "degenerate-face"
              : "simple-boundary-required";
      addBlocker(blockers, code, `Inset is not eligible: ${inset.reason}.`);
    }
  }
  if (commandId === "mesh.mergeVertices" && selected.vertex.length >= 2) {
    const targetId = args.target === "last-selected" ? selected.vertex.at(-1)! : selected.vertex[0];
    const selectedIds = new Set(selected.vertex);
    const targetPosition =
      args.target === "last-selected"
        ? vertices.get(targetId)!.position
        : ([
            selected.vertex.reduce((sum, id) => sum + vertices.get(id)!.position[0], 0) / selected.vertex.length,
            selected.vertex.reduce((sum, id) => sum + vertices.get(id)!.position[1], 0) / selected.vertex.length,
            selected.vertex.reduce((sum, id) => sum + vertices.get(id)!.position[2], 0) / selected.vertex.length,
          ] as Vec3);
    const mergedVertices = new Map(vertices);
    mergedVertices.set(targetId, { id: targetId, position: targetPosition });
    for (const face of mesh.faces) {
      const mapped = face.vertexIds.map((id) => (selectedIds.has(id) ? targetId : id));
      const compact = mapped.filter((id, index) => id !== mapped[(index + mapped.length - 1) % mapped.length]);
      if (compact.length < 3) continue;
      if (new Set(compact).size !== compact.length) {
        addBlocker(
          blockers,
          "degenerate-face",
          "Vertex merge would create a face with a repeated non-adjacent vertex.",
        );
        break;
      }
      if (faceArea({ ...face, vertexIds: compact }, mergedVertices) <= DEGENERATE_AREA_EPSILON) {
        addBlocker(blockers, "degenerate-face", "Vertex merge would leave a zero-area face.");
        break;
      }
    }
  }
  if (commandId === "mesh.bevelEdges") {
    const bevelFaceIds = new Set<string>();
    const bevelVertexIds = new Set<string>();
    for (const edge of selectedEdges) {
      const analysis = analyzeBevelEdge(mesh, edge, args.width as number);
      if (!analysis.eligible || !analysis.adjacentFaceIds || !analysis.endpoints) {
        addBlocker(blockers, analysis.reason ?? "bevel-junction", `Edge bevel is not eligible: ${analysis.reason}.`);
        continue;
      }
      const adjacentFaces = analysis.adjacentFaceIds
        .map((id) => mesh.faces.find((face) => face.id === id)!)
        .filter((face) => faceIsPlanar(face, vertices));
      if (adjacentFaces.length !== 2) {
        addBlocker(blockers, "non-planar-face", "Edge bevel requires planar adjacent faces.");
      }
      const adjacentFaceIds = analysis.adjacentFaceIds;
      const verticesAtEdge = edge.vertexIds;
      if (adjacentFaceIds.some((id) => bevelFaceIds.has(id)) || verticesAtEdge.some((id) => bevelVertexIds.has(id))) {
        addBlocker(blockers, "bevel-junction", "Selected bevels must not share endpoint vertices or adjacent faces.");
      }
      adjacentFaceIds.forEach((id) => bevelFaceIds.add(id));
      verticesAtEdge.forEach((id) => bevelVertexIds.add(id));
    }
    if (mesh.faces.some((face) => faceArea(face, vertices) <= DEGENERATE_AREA_EPSILON)) {
      addBlocker(blockers, "degenerate-face", "Bevel is not supported on a mesh containing zero-area faces.");
    }
  }
  if (commandId === "mesh.dissolveEdges") {
    for (const edge of selectedEdges) {
      const count = incidence.get(faceEdgeKey(edge.vertexIds[0], edge.vertexIds[1])) ?? 0;
      if (count !== 2) {
        addBlocker(
          blockers,
          count > 2 ? "non-manifold-edge" : "boundary-edge",
          "Selected edges must be interior manifold edges with exactly two incident faces.",
        );
      }
    }
  }
  if (commandId === "mesh.dissolveEdges" && selectedEdges.length > 0) {
    const selectedEdgeKeys = new Set(selectedEdges.map(({ vertexIds }) => faceEdgeKey(vertexIds[0], vertexIds[1])));
    const meshIncidence = edgeIncidence(mesh);
    const adjacentFaceIds = new Set(
      selectedEdges.flatMap(({ vertexIds }) => meshIncidence.get(faceEdgeKey(vertexIds[0], vertexIds[1])) ?? []),
    );
    const groups = connectedFaceGroups(
      mesh,
      mesh.faces.filter(({ id }) => adjacentFaceIds.has(id)),
      selectedEdgeKeys,
    );
    for (const group of groups) {
      if (group.length < 2) {
        addBlocker(blockers, "selection-too-small", "Edge dissolve must join at least two incident faces.");
        continue;
      }
      const groupIncidence = new Map<string, number>();
      for (const face of group) {
        for (let index = 0; index < face.vertexIds.length; index += 1) {
          const key = faceEdgeKey(face.vertexIds[index], face.vertexIds[(index + 1) % face.vertexIds.length]);
          groupIncidence.set(key, (groupIncidence.get(key) ?? 0) + 1);
        }
      }
      for (const [edgeKey, count] of groupIncidence) {
        if (count > 1 && !selectedEdgeKeys.has(edgeKey)) {
          addBlocker(
            blockers,
            "unselected-internal-edge",
            "Dissolve would remove an unselected edge inside the affected face region.",
          );
        }
      }
      const analysis = analyzeDissolveRegion(mesh, group);
      if (!analysis.eligible) {
        addBlocker(
          blockers,
          analysis.reason === "degenerate-face" ? "degenerate-face" : "simple-boundary-required",
          `Selected edges do not form a simple merged surface: ${analysis.reason}.`,
        );
      }
      if (group.some(({ materialId }) => materialId !== group[0].materialId)) {
        addBlocker(blockers, "mixed-materials", "Dissolve cannot merge faces with different materials.");
      }
    }
  }
  if (commandId === "mesh.dissolveFaces" && selectedFaces.length > 0) {
    for (const group of connectedFaceGroups(mesh, selectedFaces)) {
      if (group.length < 2) {
        addBlocker(blockers, "selection-too-small", "Face dissolve requires at least two connected selected faces.");
        continue;
      }
      const analysis = analyzeDissolveRegion(mesh, group);
      if (!analysis.eligible) {
        addBlocker(
          blockers,
          analysis.reason === "degenerate-face" ? "degenerate-face" : "simple-boundary-required",
          `Selected faces cannot be dissolved: ${analysis.reason}.`,
        );
      }
      if (group.some(({ materialId }) => materialId !== group[0].materialId)) {
        addBlocker(blockers, "mixed-materials", "Dissolve cannot merge faces with different materials.");
      }
    }
  }
  if (commandId === "mesh.loopCut") {
    const seedEdge = typeof args.edgeId === "string" ? edges.get(args.edgeId) : undefined;
    if (!seedEdge) {
      addBlocker(blockers, "not-found", "Provide an edgeId that exists on the target mesh.");
    }
    if (typeof args.position === "number" && (args.position <= 0 || args.position >= 1)) {
      addBlocker(blockers, "invalid-position", "Loop cut position must be strictly between 0 and 1.");
    }
    if (
      Number.isInteger(args.cuts) &&
      (args.cuts as number) >= 1 &&
      (args.cuts as number) <= 64 &&
      typeof args.position === "number"
    ) {
      const cutPositions = Array.from(
        { length: args.cuts as number },
        (_, index) =>
          (args.position as number) + (index - ((args.cuts as number) - 1) / 2) / ((args.cuts as number) + 1),
      );
      if (cutPositions.some((position) => position <= 0 || position >= 1)) {
        addBlocker(blockers, "loop-cut-out-of-range", "The requested cut positions would cross the loop boundary.");
      }
    }
    if (seedEdge) {
      const loop = analyzeQuadLoop(mesh, seedEdge.id);
      if (!loop.eligible) {
        addBlocker(blockers, loop.reason ?? "ambiguous-loop", `Quad loop is not eligible: ${loop.reason}.`);
      } else {
        const loopFaces = new Set(loop.faceIds);
        if (
          mesh.faces
            .filter(({ id }) => loopFaces.has(id))
            .some((face) => faceArea(face, vertices) <= DEGENERATE_AREA_EPSILON)
        ) {
          addBlocker(blockers, "degenerate-face", "Loop cut does not support zero-area faces in the traversed loop.");
        }
      }
    }
  }
  if (commandId === "mesh.recalculateNormals") {
    const seedFaceId = selected.face.length === 1 ? selected.face[0] : undefined;
    if (selected.face.length > 1) {
      addBlocker(
        blockers,
        "selection-ambiguous",
        "Select one seed face to choose a connected component for normal recalculation.",
      );
    }
    if (blockers.length === 0) {
      const analysis = analyzeNormalRecalculation(mesh, seedFaceId);
      if (!analysis.eligible) {
        const messages: Record<string, string> = {
          "selection-empty": "Normal recalculation requires a mesh with at least one face.",
          "ambiguous-component": "Select one face when the mesh contains multiple disconnected components.",
          "boundary-edge": "Normal recalculation requires a closed component without boundary edges.",
          "non-manifold-edge": "Normal recalculation requires manifold topology.",
          "degenerate-face": "Normal recalculation does not support zero-area faces.",
          "non-orientable": "The selected component cannot be consistently oriented.",
          "zero-volume": "The selected component has no measurable enclosed volume.",
        };
        addBlocker(
          blockers,
          analysis.reason ?? "normal-recalculation-failed",
          messages[analysis.reason ?? ""] ?? "Normal recalculation is not eligible.",
        );
      }
    }
  }
  if (
    commandId === "mesh.flipNormals" &&
    selectedFaces.some((face) => faceArea(face, vertices) <= DEGENERATE_AREA_EPSILON)
  ) {
    addBlocker(blockers, "degenerate-face", "Selected faces must have positive area.");
  }

  if (descriptor.id === "mesh.transformComponents" && !kind) {
    addBlocker(blockers, "invalid-selection-mode", "The command requires vertex, edge, or face mode.");
  }
  return { eligible: blockers.length === 0, blockers };
}

export function queryModelingDocument(
  document: ModelingDocument,
  queryId: string,
  argumentsValue: unknown = {},
): ModelingQueryResult {
  validateModelingDocument(document);
  validateQueryArguments(queryId, argumentsValue);
  const args = record(argumentsValue);

  switch (queryId) {
    case "scene.getHierarchy": {
      const scene = activeScene(document, args.sceneId as string | undefined);
      const offset = idOffsetArgument(args.cursor);
      const limit = pageSize(args.limit);
      const pageIds = scene.objectIds.slice(offset, offset + limit);
      const objectsById = new Map(document.objects.map((object) => [object.id, object]));
      const items = pageIds
        .map((id) => objectsById.get(id)!)
        .map((object) => ({
          id: object.id,
          name: object.name,
          parentId: object.parentId,
          visible: object.visible,
        }));
      const nextOffset = offset + items.length;
      return {
        sceneId: scene.id,
        items,
        nextCursor: nextOffset < scene.objectIds.length ? String(nextOffset) : null,
      };
    }
    case "object.getTransform": {
      const object = findObject(document, args.objectId as string);
      return { objectId: object.id, transform: copyTransform(object) };
    }
    case "mesh.getSummary": {
      const object = meshObject(document, args.objectId as string);
      const mesh = object.mesh;
      const includeComponents = args.includeComponents === true;
      const offset = includeComponents ? idOffsetArgument(args.cursor) : 0;
      const limit = pageSize(args.limit);
      const totalComponents = mesh.vertices.length + mesh.edges.length + mesh.faces.length;
      const components = includeComponents ? componentPage(mesh, offset, limit) : [];
      const nextOffset = offset + components.length;
      return {
        objectId: object.id,
        vertexCount: mesh.vertices.length,
        edgeCount: mesh.edges.length,
        faceCount: mesh.faces.length,
        components,
        nextCursor: includeComponents && nextOffset < totalComponents ? String(nextOffset) : null,
      };
    }
    case "selection.get":
      return {
        mode: document.selection.mode,
        objectIds: [...document.selection.objectIds],
        componentIds: [...document.selection.componentIds],
        activeObjectId: document.selection.activeObjectId,
      };
    case "editor.getMode":
      return {
        editor: document.selection.mode === "object" ? "object" : "mesh",
        selectionMode: document.selection.mode,
      };
    case "operation.getEligibility":
      return eligibilityForCommand(document, args.commandId as string, (args.arguments ?? {}) as QueryRecord);
    default:
      throw new ModelingContractError("unknown-query", `Unknown modeling query "${queryId}".`, { queryId });
  }
}