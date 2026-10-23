import type { CommandHandler } from "./processor.ts";
import type { ModelingDocument, ModelingObject, PolygonMesh, Vec3 } from "./document.ts";
import { ModelingContractError } from "./commands.ts";
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

type PrimitiveKind = "box" | "uv-sphere" | "cylinder";
type ComponentMode = "vertex" | "edge" | "face";
type SelectionMode = "object" | ComponentMode;

interface PrimitiveGeometry {
  positions: Vec3[];
  faces: number[][];
}

function makeBox(size: number): PrimitiveGeometry {
  const half = size / 2;
  return {
    positions: [
      [-half, -half, -half],
      [half, -half, -half],
      [half, half, -half],
      [-half, half, -half],
      [-half, -half, half],
      [half, -half, half],
      [half, half, half],
      [-half, half, half],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}

function makeUvSphere(size: number, segments: number): PrimitiveGeometry {
  const radius = size / 2;
  const latitudeSegments = Math.max(2, Math.floor(segments / 2));
  const positions: Vec3[] = [[0, 0, radius]];
  for (let latitude = 1; latitude < latitudeSegments; latitude += 1) {
    const theta = (Math.PI * latitude) / latitudeSegments;
    for (let longitude = 0; longitude < segments; longitude += 1) {
      const phi = (2 * Math.PI * longitude) / segments;
      positions.push([
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(theta) * Math.sin(phi),
        radius * Math.cos(theta),
      ]);
    }
  }
  const southPole = positions.length;
  positions.push([0, 0, -radius]);
  const faces: number[][] = [];
  const firstRing = 1;
  for (let longitude = 0; longitude < segments; longitude += 1) {
    const next = (longitude + 1) % segments;
    faces.push([0, firstRing + longitude, firstRing + next]);
  }
  for (let latitude = 0; latitude < latitudeSegments - 2; latitude += 1) {
    const upper = 1 + latitude * segments;
    const lower = upper + segments;
    for (let longitude = 0; longitude < segments; longitude += 1) {
      const next = (longitude + 1) % segments;
      faces.push([upper + longitude, lower + longitude, lower + next, upper + next]);
    }
  }
  const lastRing = 1 + (latitudeSegments - 2) * segments;
  for (let longitude = 0; longitude < segments; longitude += 1) {
    const next = (longitude + 1) % segments;
    faces.push([southPole, lastRing + next, lastRing + longitude]);
  }
  return { positions, faces };
}

function makeCylinder(size: number, segments: number): PrimitiveGeometry {
  const radius = size / 2;
  const halfHeight = size / 2;
  const positions: Vec3[] = [];
  for (const z of [-halfHeight, halfHeight]) {
    for (let index = 0; index < segments; index += 1) {
      const angle = (2 * Math.PI * index) / segments;
      positions.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
    }
  }
  const faces: number[][] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    faces.push([index, next, segments + next, segments + index]);
  }
  faces.push(Array.from({ length: segments }, (_, index) => segments + index));
  faces.push(Array.from({ length: segments }, (_, index) => segments - index - 1));
  return { positions, faces };
}

function allDocumentIds(document: ModelingDocument): Set<string> {
  const ids = new Set<string>([
    document.id,
    ...document.scenes.map(({ id }) => id),
    ...document.materials.map(({ id }) => id),
  ]);
  for (const object of document.objects) {
    ids.add(object.id);
    if (!object.mesh) continue;
    ids.add(object.mesh.id);
    for (const component of [...object.mesh.vertices, ...object.mesh.edges, ...object.mesh.faces]) {
      ids.add(component.id);
    }
  }
  return ids;
}

function allocatePrimitiveIds(document: ModelingDocument, geometry: PrimitiveGeometry) {
  const used = allDocumentIds(document);
  for (let serial = 1; ; serial += 1) {
    const objectId = `object-${serial}`;
    const meshId = `${objectId}:mesh`;
    const vertexIds = geometry.positions.map((_, index) => `${objectId}:vertex:${index + 1}`);
    const edgeKeys = new Set<string>();
    for (const face of geometry.faces) {
      for (let index = 0; index < face.length; index += 1) {
        const a = face[index];
        const b = face[(index + 1) % face.length];
        edgeKeys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
      }
    }
    const edgeIds = [...edgeKeys].map((_, index) => `${objectId}:edge:${index + 1}`);
    const faceIds = geometry.faces.map((_, index) => `${objectId}:face:${index + 1}`);
    if ([objectId, meshId, ...vertexIds, ...edgeIds, ...faceIds].every((id) => !used.has(id))) {
      return { objectId, meshId, vertexIds, edgeIds, faceIds, edgeKeys: [...edgeKeys] };
    }
  }
}

function createPrimitiveMesh(
  document: ModelingDocument,
  geometry: PrimitiveGeometry,
): { objectId: string; mesh: PolygonMesh } {
  const ids = allocatePrimitiveIds(document, geometry);
  const edgePairs = ids.edgeKeys.map((key) => key.split(":").map(Number) as [number, number]);
  return {
    objectId: ids.objectId,
    mesh: {
      id: ids.meshId,
      vertices: geometry.positions.map((position, index) => ({
        id: ids.vertexIds[index],
        position,
      })),
      edges: edgePairs.map(([a, b], index) => ({
        id: ids.edgeIds[index],
        vertexIds: [ids.vertexIds[a], ids.vertexIds[b]],
      })),
      faces: geometry.faces.map((face, index) => ({
        id: ids.faceIds[index],
        vertexIds: face.map((vertexIndex) => ids.vertexIds[vertexIndex]),
        materialId: null,
      })),
    },
  };
}

function affectedResult(document: ModelingDocument, objectIds: string[]) {
  return {
    affectedEntityIds: objectIds,
    selection: structuredClone(document.selection),
  };
}

function createIdGenerator(document: ModelingDocument, mesh: PolygonMesh) {
  const used = allDocumentIds(document);
  let serial = 1;
  return (kind: string) => {
    let id: string;
    do {
      id = `${mesh.id}:generated:${kind}:${serial}`;
      serial += 1;
    } while (used.has(id));
    used.add(id);
    return id;
  };
}

function ensureMeshEdges(mesh: PolygonMesh, allocateId: (kind: string) => string): void {
  const existing = new Set(mesh.edges.map(({ vertexIds }) => meshEdgeKey(vertexIds[0], vertexIds[1])));
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const first = face.vertexIds[index];
      const second = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = meshEdgeKey(first, second);
      if (existing.has(key)) continue;
      mesh.edges.push({ id: allocateId("edge"), vertexIds: [first, second] });
      existing.add(key);
    }
  }
}

function rebuildMeshEdges(mesh: PolygonMesh, allocateId: (kind: string) => string): void {
  const existing = new Map(mesh.edges.map((edge) => [meshEdgeKey(edge.vertexIds[0], edge.vertexIds[1]), edge]));
  const rebuilt = new Map<string, PolygonMesh["edges"][number]>();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const first = face.vertexIds[index];
      const second = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = meshEdgeKey(first, second);
      if (rebuilt.has(key)) continue;
      const retained = existing.get(key);
      rebuilt.set(key, retained ?? { id: allocateId("edge"), vertexIds: [first, second] });
    }
  }
  mesh.edges = [...rebuilt.values()];
}

function applyComponentSelectionState(
  document: ModelingDocument,
  objectId: string,
  mode: "vertex" | "edge" | "face",
  componentIds: string[],
): void {
  document.selection = {
    mode,
    objectIds: [objectId],
    componentIds,
    activeObjectId: objectId,
  };
}

function selectedComponents(mesh: PolygonMesh, mode: "vertex" | "edge" | "face", ids: readonly string[]) {
  const selected = new Set(ids);
  const collection = mode === "vertex" ? mesh.vertices : mode === "edge" ? mesh.edges : mesh.faces;
  return collection.filter(({ id }) => selected.has(id));
}

function extrudeVertex(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  vertexId: string,
  displacement: Vec3,
  allocateId: (kind: string) => string,
): string {
  const source = object.mesh.vertices.find(({ id }) => id === vertexId)!;
  const vertexIdNew = allocateId("vertex");
  object.mesh.vertices.push({
    id: vertexIdNew,
    position: [
      source.position[0] + displacement[0],
      source.position[1] + displacement[1],
      source.position[2] + displacement[2],
    ],
  });
  const edgeId = allocateId("edge");
  object.mesh.edges.push({ id: edgeId, vertexIds: [source.id, vertexIdNew] });
  applyComponentSelectionState(document, object.id, "edge", [edgeId]);
  return edgeId;
}

function orientedFaceEdge(face: PolygonMesh["faces"][number], edgeKey: string): [string, string] | null {
  for (let index = 0; index < face.vertexIds.length; index += 1) {
    const first = face.vertexIds[index];
    const second = face.vertexIds[(index + 1) % face.vertexIds.length];
    if (meshEdgeKey(first, second) === edgeKey) return [first, second];
  }
  return null;
}

function extrudeEdgeChain(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  selectedEdges: PolygonMesh["edges"],
  displacement: Vec3,
  allocateId: (kind: string) => string,
): string[] {
  const mesh = object.mesh;
  const incidence = edgeIncidence(mesh);
  const duplicateByVertex = new Map<string, string>();
  for (const edge of selectedEdges) {
    for (const vertexId of edge.vertexIds) {
      if (duplicateByVertex.has(vertexId)) continue;
      const source = mesh.vertices.find(({ id }) => id === vertexId)!;
      const duplicateId = allocateId("vertex");
      mesh.vertices.push({
        id: duplicateId,
        position: [
          source.position[0] + displacement[0],
          source.position[1] + displacement[1],
          source.position[2] + displacement[2],
        ],
      });
      duplicateByVertex.set(vertexId, duplicateId);
    }
  }
  const createdFaceIds: string[] = [];
  for (const selectedEdge of selectedEdges) {
    const key = meshEdgeKey(selectedEdge.vertexIds[0], selectedEdge.vertexIds[1]);
    const adjacentFaceId = incidence.get(key)?.[0];
    const adjacentFace = mesh.faces.find(({ id }) => id === adjacentFaceId)!;
    const oriented = orientedFaceEdge(adjacentFace, key)!;
    const [first, second] = oriented;
    const translatedEdgeId = allocateId("edge");
    mesh.edges.push({
      id: translatedEdgeId,
      vertexIds: [duplicateByVertex.get(first)!, duplicateByVertex.get(second)!],
    });
    const faceId = allocateId("face");
    mesh.faces.push({
      id: faceId,
      vertexIds: [second, first, duplicateByVertex.get(first)!, duplicateByVertex.get(second)!],
      materialId: adjacentFace.materialId,
    });
    createdFaceIds.push(faceId);
  }
  ensureMeshEdges(mesh, allocateId);
  applyComponentSelectionState(document, object.id, "face", createdFaceIds);
  return createdFaceIds;
}

function extrudeFaceRegion(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  selectedFaces: PolygonMesh["faces"],
  displacement: Vec3,
  allocateId: (kind: string) => string,
): string[] {
  const mesh = object.mesh;
  const incidence = edgeIncidence(mesh);
  const selectedIncidence = new Map<string, number>();
  const orientedBoundary: Array<[string, string, PolygonMesh["faces"][number]]> = [];
  const sourceVertices = new Set(selectedFaces.flatMap(({ vertexIds }) => vertexIds));
  for (const face of selectedFaces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const first = face.vertexIds[index];
      const second = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = meshEdgeKey(first, second);
      selectedIncidence.set(key, (selectedIncidence.get(key) ?? 0) + 1);
      if ((incidence.get(key)?.length ?? 0) <= 2) orientedBoundary.push([first, second, face]);
    }
  }
  const boundary = orientedBoundary.filter(([first, second]) => {
    const key = meshEdgeKey(first, second);
    return selectedIncidence.get(key) === 1;
  });
  const replacesExistingSurface = boundary.some(
    ([first, second]) => (incidence.get(meshEdgeKey(first, second))?.length ?? 0) > 1,
  );
  if (replacesExistingSurface) {
    const selectedFaceIds = new Set(selectedFaces.map(({ id }) => id));
    mesh.faces = mesh.faces.filter(({ id }) => !selectedFaceIds.has(id));
  }
  const duplicateByVertex = new Map<string, string>();
  for (const vertexId of sourceVertices) {
    const source = mesh.vertices.find(({ id }) => id === vertexId)!;
    const duplicateId = allocateId("vertex");
    mesh.vertices.push({
      id: duplicateId,
      position: [
        source.position[0] + displacement[0],
        source.position[1] + displacement[1],
        source.position[2] + displacement[2],
      ],
    });
    duplicateByVertex.set(vertexId, duplicateId);
  }
  const capFaceIds: string[] = [];
  for (const face of selectedFaces) {
    const faceId = allocateId("face");
    mesh.faces.push({
      id: faceId,
      vertexIds: face.vertexIds.map((id) => duplicateByVertex.get(id)!),
      materialId: face.materialId,
    });
    capFaceIds.push(faceId);
  }
  for (const [first, second, sourceFace] of boundary) {
    const sideFaceId = allocateId("face");
    mesh.faces.push({
      id: sideFaceId,
      vertexIds: [second, first, duplicateByVertex.get(first)!, duplicateByVertex.get(second)!],
      materialId: sourceFace.materialId,
    });
  }
  ensureMeshEdges(mesh, allocateId);
  applyComponentSelectionState(document, object.id, "face", capFaceIds);
  return capFaceIds;
}

function insetFaceRegion(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  selectedFaces: PolygonMesh["faces"],
  offset: number,
  allocateId: (kind: string) => string,
): string[] {
  const analysis = analyzeInset(object.mesh, selectedFaces, offset);
  if (!analysis.eligible || !analysis.boundary) {
    throw new ModelingContractError("operation-ineligible", `Face inset is not eligible: ${analysis.reason}.`, {
      reason: analysis.reason,
      faceIds: selectedFaces.map(({ id }) => id),
      offset,
    });
  }
  const mesh = object.mesh;
  const duplicateByVertex = new Map<string, string>();
  for (const vertexId of analysis.boundary.vertexIds) {
    const newId = allocateId("vertex");
    mesh.vertices.push({
      id: newId,
      position: analysis.boundary.positions.get(vertexId)!,
    });
    duplicateByVertex.set(vertexId, newId);
  }
  for (const face of selectedFaces) {
    face.vertexIds = face.vertexIds.map((id) => duplicateByVertex.get(id) ?? id);
  }
  const originalEdges = new Set(mesh.edges.map(({ vertexIds }) => meshEdgeKey(vertexIds[0], vertexIds[1])));
  const ringFaceIds: string[] = [];
  const loop = analysis.boundary.vertexIds;
  for (let index = 0; index < loop.length; index += 1) {
    const first = loop[index];
    const second = loop[(index + 1) % loop.length];
    const newFirst = duplicateByVertex.get(first)!;
    const newSecond = duplicateByVertex.get(second)!;
    const sourceFace = selectedFaces.find(
      (face) => face.vertexIds.includes(newFirst) && face.vertexIds.includes(newSecond),
    );
    const materialId = sourceFace?.materialId ?? selectedFaces[0].materialId;
    const faceId = allocateId("face");
    mesh.faces.push({
      id: faceId,
      vertexIds: [first, second, newSecond, newFirst],
      materialId,
    });
    ringFaceIds.push(faceId);
    if (!originalEdges.has(meshEdgeKey(first, second))) {
      throw new ModelingContractError(
        "operation-ineligible",
        "Inset boundary edge is not represented by the source mesh.",
        {
          edge: [first, second],
        },
      );
    }
  }
  ensureMeshEdges(mesh, allocateId);
  const innerFaceIds = selectedFaces.map(({ id }) => id);
  applyComponentSelectionState(document, object.id, "face", innerFaceIds);
  return innerFaceIds;
}

function mergeVertices(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  vertexIds: string[],
  target: "center" | "last-selected",
): string {
  const mesh = object.mesh;
  const selected = new Set(vertexIds);
  const targetId = target === "last-selected" ? vertexIds.at(-1)! : vertexIds[0];
  const mergeVerticesList = mesh.vertices.filter(({ id }) => selected.has(id));
  const targetVertex = mergeVerticesList.find(({ id }) => id === targetId)!;
  if (target === "center") {
    targetVertex.position = [
      mergeVerticesList.reduce((sum, vertex) => sum + vertex.position[0], 0) / mergeVerticesList.length,
      mergeVerticesList.reduce((sum, vertex) => sum + vertex.position[1], 0) / mergeVerticesList.length,
      mergeVerticesList.reduce((sum, vertex) => sum + vertex.position[2], 0) / mergeVerticesList.length,
    ];
  }

  const remap = (id: string) => (selected.has(id) ? targetId : id);
  mesh.vertices = mesh.vertices.filter(({ id }) => !selected.has(id) || id === targetId);
  mesh.edges = mesh.edges
    .map((edge) => ({ ...edge, vertexIds: edge.vertexIds.map(remap) as [string, string] }))
    .filter(({ vertexIds: [first, second] }) => first !== second);
  const uniqueEdges = new Set<string>();
  mesh.edges = mesh.edges.filter((edge) => {
    const key = meshEdgeKey(edge.vertexIds[0], edge.vertexIds[1]);
    if (uniqueEdges.has(key)) return false;
    uniqueEdges.add(key);
    return true;
  });

  const retainedFaces: PolygonMesh["faces"] = [];
  for (const face of mesh.faces) {
    const mapped = face.vertexIds.map(remap);
    const compact = mapped.filter((id, index) => id !== mapped[(index + mapped.length - 1) % mapped.length]);
    if (compact.length < 3) continue;
    if (new Set(compact).size !== compact.length) {
      throw new ModelingContractError(
        "operation-ineligible",
        "Vertex merge would create a face with a repeated non-adjacent vertex.",
        {
          reason: "degenerate-face",
          faceId: face.id,
        },
      );
    }
    retainedFaces.push({ ...face, vertexIds: compact });
  }
  mesh.faces = retainedFaces;
  applyComponentSelectionState(document, object.id, "vertex", [targetId]);
  return targetId;
}

function dissolveFaceGroups(
  document: ModelingDocument,
  object: ModelingObject & { mesh: PolygonMesh },
  faceGroups: PolygonMesh["faces"][],
  removedEdgeKeys: Set<string>,
  allocateId: (kind: string) => string,
): string[] {
  const mesh = object.mesh;
  const removeFaceIds = new Set<string>();
  const resultingFaces: PolygonMesh["faces"] = [];
  const resultingIds: string[] = [];
  for (const group of faceGroups) {
    if (group.length < 2) {
      throw new ModelingContractError("operation-ineligible", "Dissolve requires at least two connected faces.", {
        reason: "selection-too-small",
        faceIds: group.map(({ id }) => id),
      });
    }
    const analysis = analyzeDissolveRegion(mesh, group);
    if (!analysis.eligible || !analysis.boundary) {
      throw new ModelingContractError("operation-ineligible", `Dissolve is not eligible: ${analysis.reason}.`, {
        reason: analysis.reason,
        faceIds: group.map(({ id }) => id),
      });
    }
    if (group.some(({ materialId }) => materialId !== group[0].materialId)) {
      throw new ModelingContractError("operation-ineligible", "Dissolve cannot merge faces with different materials.", {
        reason: "mixed-materials",
        faceIds: group.map(({ id }) => id),
      });
    }
    const retained = group[0];
    for (const face of group) removeFaceIds.add(face.id);
    resultingFaces.push({
      id: retained.id,
      vertexIds: analysis.boundary,
      materialId: retained.materialId,
    });
    resultingIds.push(retained.id);

    const groupIds = new Set(group.map(({ id }) => id));
    for (const [key, incidentFaceIds] of edgeIncidence(mesh)) {
      if (incidentFaceIds.filter((id) => groupIds.has(id)).length > 1) removedEdgeKeys.add(key);
    }
  }
  mesh.faces = mesh.faces.filter(({ id }) => !removeFaceIds.has(id)).concat(resultingFaces);
  mesh.edges = mesh.edges.filter(({ vertexIds }) => !removedEdgeKeys.has(meshEdgeKey(vertexIds[0], vertexIds[1])));
  ensureMeshEdges(mesh, allocateId);
  return resultingIds;
}

const mergeSelectedVertices: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const vertexIds = args.vertexIds as string[];
  const mergedId = mergeVertices(
    document,
    object as ModelingObject & { mesh: PolygonMesh },
    vertexIds,
    args.target as "center" | "last-selected",
  );
  return { document, result: affectedResult(document, [object.id, mergedId]) };
};

const dissolveSelectedEdges: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mesh = object.mesh;
  const edgeIds = args.edgeIds as string[];
  const selectedEdges = mesh.edges.filter(({ id }) => edgeIds.includes(id));
  const selectedEdgeKeys = new Set(selectedEdges.map(({ vertexIds }) => meshEdgeKey(vertexIds[0], vertexIds[1])));
  const incidence = edgeIncidence(mesh);
  const adjacentFaces = new Set(
    selectedEdges.flatMap(({ vertexIds }) => incidence.get(meshEdgeKey(vertexIds[0], vertexIds[1])) ?? []),
  );
  const selectedFaces = mesh.faces.filter(({ id }) => adjacentFaces.has(id));
  const groups = connectedFaceGroups(mesh, selectedFaces, selectedEdgeKeys);
  const mergedIds = dissolveFaceGroups(
    document,
    object as ModelingObject & { mesh: PolygonMesh },
    groups,
    selectedEdgeKeys,
    createIdGenerator(document, mesh),
  );
  applyComponentSelectionState(document, object.id, "face", mergedIds);
  return { document, result: affectedResult(document, [object.id, ...mergedIds]) };
};

const dissolveSelectedFaces: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mesh = object.mesh;
  const faceIds = args.faceIds as string[];
  const selectedFaces = mesh.faces.filter(({ id }) => faceIds.includes(id));
  const groups = connectedFaceGroups(mesh, selectedFaces);
  const mergedIds = dissolveFaceGroups(
    document,
    object as ModelingObject & { mesh: PolygonMesh },
    groups,
    new Set(),
    createIdGenerator(document, mesh),
  );
  applyComponentSelectionState(document, object.id, "face", mergedIds);
  return { document, result: affectedResult(document, [object.id, ...mergedIds]) };
};

function bevelEdge(
  mesh: PolygonMesh,
  edge: PolygonMesh["edges"][number],
  width: number,
  segments: number,
  allocateId: (kind: string) => string,
): string[] {
  const analysis = analyzeBevelEdge(mesh, edge, width);
  if (!analysis.eligible || !analysis.adjacentFaceIds || !analysis.endpoints) {
    throw new ModelingContractError("operation-ineligible", `Edge bevel is not eligible: ${analysis.reason}.`, {
      reason: analysis.reason,
      edgeId: edge.id,
      width,
    });
  }
  const [firstFaceId, secondFaceId] = analysis.adjacentFaceIds;
  const bevelVertexIds = new Map<string, string[]>();
  for (const endpoint of analysis.endpoints) {
    const firstPoint = endpoint.pointsByAdjacentFace.get(firstFaceId)!;
    const secondPoint = endpoint.pointsByAdjacentFace.get(secondFaceId)!;
    const ids = [allocateId("vertex")];
    mesh.vertices.push({ id: ids[0], position: firstPoint });
    for (let segment = 1; segment < segments; segment += 1) {
      const t = segment / segments;
      const id = allocateId("vertex");
      mesh.vertices.push({
        id,
        position: [
          firstPoint[0] + (secondPoint[0] - firstPoint[0]) * t,
          firstPoint[1] + (secondPoint[1] - firstPoint[1]) * t,
          firstPoint[2] + (secondPoint[2] - firstPoint[2]) * t,
        ],
      });
      ids.push(id);
    }
    const lastId = allocateId("vertex");
    mesh.vertices.push({ id: lastId, position: secondPoint });
    ids.push(lastId);
    bevelVertexIds.set(endpoint.vertexId, ids);
  }

  const [startId, endId] = edge.vertexIds;
  const faceReplacements = new Map<string, Map<string, string[]>>();
  for (const faceId of analysis.adjacentFaceIds) {
    const replacements = new Map<string, string[]>();
    for (const endpoint of analysis.endpoints) {
      const pointId = endpoint.pointsByAdjacentFace.has(faceId)
        ? bevelVertexIds.get(endpoint.vertexId)![analysis.adjacentFaceIds.indexOf(faceId) === 0 ? 0 : segments]
        : undefined;
      if (pointId) replacements.set(endpoint.vertexId, [pointId]);
    }
    faceReplacements.set(faceId, replacements);
  }
  for (const endpoint of analysis.endpoints) {
    const cornerFace = mesh.faces.find(({ id }) => id === endpoint.cornerFaceId)!;
    const vertexIndex = cornerFace.vertexIds.indexOf(endpoint.vertexId);
    const previousId =
      cornerFace.vertexIds[(vertexIndex + cornerFace.vertexIds.length - 1) % cornerFace.vertexIds.length];
    const nextId = cornerFace.vertexIds[(vertexIndex + 1) % cornerFace.vertexIds.length];
    const previousFaceId = [...endpoint.adjacentEdgeByFace].find(
      ([, key]) => key === meshEdgeKey(previousId, endpoint.vertexId),
    )?.[0];
    const nextFaceId = [...endpoint.adjacentEdgeByFace].find(
      ([, key]) => key === meshEdgeKey(endpoint.vertexId, nextId),
    )?.[0];
    if (!previousFaceId || !nextFaceId) {
      throw new ModelingContractError("operation-ineligible", "Bevel endpoint fan is ambiguous.", {
        reason: "bevel-junction",
        vertexId: endpoint.vertexId,
      });
    }
    const laneIds = bevelVertexIds.get(endpoint.vertexId)!;
    const ordered = previousFaceId === firstFaceId ? laneIds : [...laneIds].reverse();
    const replacements = faceReplacements.get(cornerFace.id) ?? new Map<string, string[]>();
    replacements.set(endpoint.vertexId, ordered);
    faceReplacements.set(cornerFace.id, replacements);
  }

  for (const face of mesh.faces) {
    const replacements = faceReplacements.get(face.id);
    if (!replacements) continue;
    face.vertexIds = face.vertexIds.flatMap((id) => replacements.get(id) ?? [id]);
  }
  const materialId = mesh.faces.find(({ id }) => id === firstFaceId)!.materialId;
  const bevelFaceIds: string[] = [];
  const startLanes = bevelVertexIds.get(startId)!;
  const endLanes = bevelVertexIds.get(endId)!;
  for (let segment = 0; segment < segments; segment += 1) {
    const id = allocateId("face");
    mesh.faces.push({
      id,
      vertexIds: [startLanes[segment], endLanes[segment], endLanes[segment + 1], startLanes[segment + 1]],
      materialId,
    });
    bevelFaceIds.push(id);
  }
  rebuildMeshEdges(mesh, allocateId);
  return bevelFaceIds;
}

const bevelSelectedEdges: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mesh = object.mesh;
  const edges = args.edgeIds as string[];
  const width = args.width as number;
  const segments = args.segments as number;
  const allocateId = createIdGenerator(document, mesh);
  const bevelFaces: string[] = [];
  for (const edgeId of edges) {
    const edge = mesh.edges.find(({ id }) => id === edgeId);
    if (!edge) {
      throw new ModelingContractError("not-found", `Edge "${edgeId}" was not found on the target mesh.`, {
        entityType: "edge",
        entityId: edgeId,
      });
    }
    bevelFaces.push(...bevelEdge(mesh, edge, width, segments, allocateId));
  }
  applyComponentSelectionState(document, object.id, "face", bevelFaces);
  return { document, result: affectedResult(document, [object.id, ...bevelFaces]) };
};

const cutQuadLoop: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mesh = object.mesh;
  const analysis = analyzeQuadLoop(mesh, args.edgeId as string);
  if (!analysis.eligible || !analysis.edgeIds || !analysis.faceIds || !analysis.crossedByFace) {
    throw new ModelingContractError("operation-ineligible", `Quad loop cut is not eligible: ${analysis.reason}.`, {
      reason: analysis.reason,
      edgeId: args.edgeId,
    });
  }
  const cuts = args.cuts as number;
  const position = args.position as number;
  const cutPositions = Array.from({ length: cuts }, (_, index) => position + (index - (cuts - 1) / 2) / (cuts + 1));
  if (cutPositions.some((value) => value <= 0 || value >= 1)) {
    throw new ModelingContractError("operation-ineligible", "Loop cut positions would cross the loop boundary.", {
      reason: "loop-cut-out-of-range",
      cuts,
      position,
    });
  }
  const allocateId = createIdGenerator(document, mesh);
  const cutIdsByEdge = new Map<string, string[]>();
  const vertexById = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex]));
  const edgeById = new Map(mesh.edges.map((edge) => [edge.id, edge]));
  for (const edgeId of analysis.edgeIds) {
    const edge = edgeById.get(edgeId)!;
    const [firstId, secondId] = edge.vertexIds;
    const first = vertexById.get(firstId)!.position;
    const second = vertexById.get(secondId)!.position;
    const ids: string[] = [];
    for (const t of cutPositions) {
      const id = allocateId("vertex");
      mesh.vertices.push({
        id,
        position: [
          first[0] + (second[0] - first[0]) * t,
          first[1] + (second[1] - first[1]) * t,
          first[2] + (second[2] - first[2]) * t,
        ],
      });
      ids.push(id);
    }
    cutIdsByEdge.set(edgeId, ids);
  }

  const splitFaceIds = new Set(analysis.faceIds);
  const newFaces: PolygonMesh["faces"] = [];
  const selectedEdgeKeys: string[] = [];
  const retainedFaces: PolygonMesh["faces"] = [];
  for (const face of mesh.faces) {
    if (!splitFaceIds.has(face.id)) {
      retainedFaces.push(face);
      continue;
    }
    const pair = analysis.crossedByFace.get(face.id)!;
    const firstEdge = edgeById.get(pair[0])!;
    const firstKey = meshEdgeKey(firstEdge.vertexIds[0], firstEdge.vertexIds[1]);
    const firstIndex = face.vertexIds.findIndex(
      (vertexId, index) => meshEdgeKey(vertexId, face.vertexIds[(index + 1) % 4]) === firstKey,
    );
    if (firstIndex < 0) {
      throw new ModelingContractError("operation-ineligible", "Quad loop crosses an ambiguous face.", {
        reason: "ambiguous-loop",
        faceId: face.id,
      });
    }
    const firstIds = cutIdsByEdge.get(pair[0])!;
    const secondIds = cutIdsByEdge.get(pair[1])!;
    const directedFirstIds = firstEdge.vertexIds[0] === face.vertexIds[firstIndex] ? firstIds : [...firstIds].reverse();
    const secondEdge = edgeById.get(pair[1])!;
    const secondStart = face.vertexIds[(firstIndex + 2) % 4];
    const directedSecondIds = secondEdge.vertexIds[0] === secondStart ? secondIds : [...secondIds].reverse();
    const left = [face.vertexIds[firstIndex], ...directedFirstIds, face.vertexIds[(firstIndex + 1) % 4]];
    const right = [
      face.vertexIds[(firstIndex + 3) % 4],
      ...[...directedSecondIds].reverse(),
      face.vertexIds[(firstIndex + 2) % 4],
    ];
    for (let segment = 0; segment <= cuts; segment += 1) {
      const faceId = segment === 0 ? face.id : allocateId("face");
      const nextFace = {
        id: faceId,
        vertexIds: [left[segment], left[segment + 1], right[segment + 1], right[segment]],
        materialId: face.materialId,
      };
      if (segment === 0) retainedFaces.push(nextFace);
      else newFaces.push(nextFace);
    }
    for (let cutIndex = 1; cutIndex <= cuts; cutIndex += 1) {
      selectedEdgeKeys.push(meshEdgeKey(left[cutIndex], right[cutIndex]));
    }
  }
  mesh.faces = retainedFaces.concat(newFaces);
  rebuildMeshEdges(mesh, allocateId);
  const selectedEdgeIds = selectedEdgeKeys.map(
    (key) => mesh.edges.find((edge) => meshEdgeKey(edge.vertexIds[0], edge.vertexIds[1]) === key)!.id,
  );
  applyComponentSelectionState(document, object.id, "edge", selectedEdgeIds);
  return { document, result: affectedResult(document, [object.id, ...selectedEdgeIds]) };
};

const recalculateNormals: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const seedFaceId =
    document.selection.mode === "face" && document.selection.activeObjectId === object.id
      ? document.selection.componentIds[0]
      : undefined;
  const analysis = analyzeNormalRecalculation(object.mesh, seedFaceId);
  if (!analysis.eligible || !analysis.faceIds || !analysis.facesToFlip) {
    throw new ModelingContractError(
      "operation-ineligible",
      `Normal recalculation is not eligible: ${analysis.reason}.`,
      {
        reason: analysis.reason,
        objectId: object.id,
        seedFaceId: seedFaceId ?? null,
      },
    );
  }
  const flipIds = new Set(analysis.facesToFlip);
  for (const face of object.mesh.faces) {
    if (flipIds.has(face.id)) face.vertexIds.reverse();
  }
  return { document, result: affectedResult(document, [object.id, ...analysis.facesToFlip]) };
};

const flipSelectedNormals: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const faceIds = args.faceIds as string[];
  const selectedIds = new Set(faceIds);
  const faces = object.mesh.faces.filter(({ id }) => selectedIds.has(id));
  if (faces.length !== faceIds.length || faces.length === 0) {
    throw new ModelingContractError(
      "operation-ineligible",
      "Flip normals requires one or more existing selected faces.",
      {
        reason: "selection-empty",
        faceIds,
      },
    );
  }
  for (const face of faces) face.vertexIds.reverse();
  return { document, result: affectedResult(document, [object.id, ...faceIds]) };
};

const extrudeComponents: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mesh = object.mesh;
  const mode = args.mode as ComponentMode;
  const ids = args.componentIds as string[];
  const components = selectedComponents(mesh, mode, ids);
  const direction = normalizedDirection(args.direction as Vec3);
  if (!direction) {
    throw new ModelingContractError("operation-ineligible", "Extrusion direction must be a non-zero vector.", {
      reason: "zero-direction",
    });
  }
  const distance = args.distance as number;
  if (distance === 0) {
    throw new ModelingContractError("operation-ineligible", "Extrusion distance must be non-zero.", {
      reason: "zero-distance",
    });
  }
  const displacement: Vec3 = [direction[0] * distance, direction[1] * distance, direction[2] * distance];
  const allocateId = createIdGenerator(document, mesh);
  if (mode === "vertex") {
    const edgeId = extrudeVertex(
      document,
      object as ModelingObject & { mesh: PolygonMesh },
      components[0].id,
      displacement,
      allocateId,
    );
    return { document, result: affectedResult(document, [object.id, edgeId]) };
  }
  if (mode === "edge") {
    const faceIds = extrudeEdgeChain(
      document,
      object as ModelingObject & { mesh: PolygonMesh },
      components as PolygonMesh["edges"],
      displacement,
      allocateId,
    );
    return { document, result: affectedResult(document, [object.id, ...faceIds]) };
  }
  const capIds = extrudeFaceRegion(
    document,
    object as ModelingObject & { mesh: PolygonMesh },
    components as PolygonMesh["faces"],
    displacement,
    allocateId,
  );
  return { document, result: affectedResult(document, [object.id, ...capIds]) };
};

const insetFaces: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const faces = selectedComponents(object.mesh, "face", args.faceIds as string[]) as PolygonMesh["faces"];
  const allocateId = createIdGenerator(document, object.mesh);
  const innerFaceIds = insetFaceRegion(
    document,
    object as ModelingObject & { mesh: PolygonMesh },
    faces,
    args.offset as number,
    allocateId,
  );
  return { document, result: affectedResult(document, [object.id, ...innerFaceIds]) };
};

const createPrimitive: CommandHandler = (document, args) => {
  const primitive = args.primitive as PrimitiveKind;
  const size = (args.size as number | undefined) ?? 2;
  const segments = (args.segments as number | undefined) ?? 16;
  const geometry =
    primitive === "box"
      ? makeBox(size)
      : primitive === "uv-sphere"
        ? makeUvSphere(size, segments)
        : makeCylinder(size, segments);
  const { objectId, mesh } = createPrimitiveMesh(document, geometry);
  const object: ModelingObject = {
    id: objectId,
    name: (args.name as string | undefined) ?? primitive,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    mesh,
    visible: true,
    parentId: null,
  };
  const scene = document.scenes.find(({ id }) => id === document.activeSceneId);
  if (!scene) {
    throw new ModelingContractError("not-found", "The active scene does not exist.", {
      entityType: "scene",
      entityId: document.activeSceneId,
    });
  }
  document.objects.push(object);
  scene.objectIds.push(object.id);
  document.selection = {
    mode: "object",
    objectIds: [object.id],
    componentIds: [],
    activeObjectId: object.id,
  };
  return { document, result: affectedResult(document, [object.id]) };
};

const setObjectTransform: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object) {
    throw new ModelingContractError("not-found", "The target object does not exist.", {
      entityType: "object",
      entityId: args.objectId,
    });
  }
  object.transform = structuredClone(args.transform) as ModelingObject["transform"];
  return { document, result: affectedResult(document, [object.id]) };
};

const renameObject: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object || !document.scenes.find(({ id }) => id === document.activeSceneId)?.objectIds.includes(object.id)) {
    throw new ModelingContractError("not-found", "The target object does not exist in the active scene.", {
      entityType: "object",
      entityId: args.objectId,
    });
  }
  object.name = args.name as string;
  return { document, result: affectedResult(document, [object.id]) };
};

const duplicateObject: CommandHandler = (document, args) => {
  const scene = document.scenes.find(({ id }) => id === document.activeSceneId);
  const source = document.objects.find(({ id }) => id === args.objectId);
  if (!scene || !source || !scene.objectIds.includes(source.id)) {
    throw new ModelingContractError("not-found", "The target object does not exist in the active scene.", {
      entityType: "object",
      entityId: args.objectId,
    });
  }
  const copy = structuredClone(source);
  let serial = 1;
  const nextObjectId = () => {
    let candidate: string;
    do candidate = `${source.id}:copy:${serial++}`;
    while (allDocumentIds(document).has(candidate));
    return candidate;
  };
  copy.id = nextObjectId();
  copy.name = (args.name as string | undefined) ?? `${source.name} copy`;
  const offset = (args.offset as Vec3 | undefined) ?? [0, 0, 0];
  copy.transform.position = copy.transform.position.map((value, axis) => value + offset[axis]) as Vec3;
  if (copy.mesh) {
    const idMap = new Map<string, string>();
    idMap.set(copy.mesh.id, `${copy.id}:mesh`);
    copy.mesh.vertices.forEach(({ id }, index) => idMap.set(id, `${copy.id}:vertex:${index + 1}`));
    copy.mesh.edges.forEach(({ id }, index) => idMap.set(id, `${copy.id}:edge:${index + 1}`));
    copy.mesh.faces.forEach(({ id }, index) => idMap.set(id, `${copy.id}:face:${index + 1}`));
    copy.mesh.id = idMap.get(copy.mesh.id)!;
    copy.mesh.vertices.forEach((vertex) => {
      vertex.id = idMap.get(vertex.id)!;
    });
    copy.mesh.edges.forEach((edge) => {
      edge.id = idMap.get(edge.id)!;
      edge.vertexIds = edge.vertexIds.map((id) => idMap.get(id)!) as [string, string];
    });
    copy.mesh.faces.forEach((face) => {
      face.id = idMap.get(face.id)!;
      face.vertexIds = face.vertexIds.map((id) => idMap.get(id)!);
    });
  }
  document.objects.push(copy);
  scene.objectIds.push(copy.id);
  document.selection = { mode: "object", objectIds: [copy.id], componentIds: [], activeObjectId: copy.id };
  return { document, result: affectedResult(document, [copy.id]) };
};

const setObjectVisibility: CommandHandler = (document, args) => {
  const scene = document.scenes.find(({ id }) => id === document.activeSceneId);
  const objectIds = args.objectIds as string[];
  if (!scene || objectIds.some((id) => !scene.objectIds.includes(id))) {
    throw new ModelingContractError("not-found", "Every target object must exist in the active scene.", {
      entityType: "object",
      objectIds,
    });
  }
  for (const object of document.objects) {
    if (objectIds.includes(object.id)) object.visible = args.visible as boolean;
  }
  return { document, result: affectedResult(document, objectIds) };
};

const deleteObjects: CommandHandler = (document, args) => {
  const scene = document.scenes.find(({ id }) => id === document.activeSceneId);
  const objectIds = args.objectIds as string[];
  if (!scene || objectIds.some((id) => !scene.objectIds.includes(id))) {
    throw new ModelingContractError("not-found", "Every target object must exist in the active scene.", {
      entityType: "object",
      objectIds,
    });
  }
  const deleted = new Set(objectIds);
  scene.objectIds = scene.objectIds.filter((id) => !deleted.has(id));
  document.objects = document.objects.filter(({ id }) => !deleted.has(id));
  const remainingSelection = document.selection.objectIds.filter((id) => !deleted.has(id));
  if (document.selection.mode === "object") {
    const activeObjectId = remainingSelection.includes(document.selection.activeObjectId ?? "")
      ? document.selection.activeObjectId
      : (remainingSelection.at(-1) ?? null);
    document.selection = { mode: "object", objectIds: remainingSelection, componentIds: [], activeObjectId };
  } else if (deleted.has(document.selection.activeObjectId ?? "")) {
    document.selection = { mode: "object", objectIds: [], componentIds: [], activeObjectId: null };
  }
  return { document, result: affectedResult(document, objectIds) };
};

function selectionObjectIds(document: ModelingDocument, args: Record<string, unknown>): string[] {
  const ids = args.objectIds as string[];
  const scene = document.scenes.find(({ id }) => id === document.activeSceneId);
  if (!scene || ids.some((id) => !scene.objectIds.includes(id))) {
    throw new ModelingContractError("operation-ineligible", "Every selected object must belong to the active scene.", {
      objectIds: ids,
      activeSceneId: document.activeSceneId,
    });
  }
  if (new Set(ids).size !== ids.length) {
    throw new ModelingContractError("invalid-arguments", "Object selection cannot contain duplicate IDs.", {
      path: "$.arguments.objectIds",
    });
  }
  return ids;
}

const setObjectSelection: CommandHandler = (document, args) => {
  const objectIds = selectionObjectIds(document, args);
  const activeObjectId = objectIds.includes(document.selection.activeObjectId ?? "")
    ? document.selection.activeObjectId
    : (objectIds.at(-1) ?? null);
  document.selection = {
    mode: "object",
    objectIds,
    componentIds: [],
    activeObjectId,
  };
  return { document, result: affectedResult(document, objectIds) };
};

const setComponentSelection: CommandHandler = (document, args) => {
  const objectId = args.objectId as string;
  const object = document.objects.find(({ id }) => id === objectId);
  if (!object?.mesh || !document.scenes.find(({ id }) => id === document.activeSceneId)?.objectIds.includes(objectId)) {
    throw new ModelingContractError(
      "operation-ineligible",
      "Component selection requires an editable mesh in the active scene.",
      {
        objectId,
      },
    );
  }
  const mode = args.mode as ComponentMode;
  const componentIds = args.componentIds as string[];
  if (new Set(componentIds).size !== componentIds.length) {
    throw new ModelingContractError("invalid-arguments", "Component selection cannot contain duplicate IDs.", {
      path: "$.arguments.componentIds",
    });
  }
  const collection = mode === "vertex" ? object.mesh.vertices : mode === "edge" ? object.mesh.edges : object.mesh.faces;
  const available = new Set(collection.map(({ id }) => id));
  if (componentIds.some((id) => !available.has(id))) {
    throw new ModelingContractError(
      "operation-ineligible",
      "Every selected component must exist in the requested mode on the target mesh.",
      {
        objectId,
        mode,
        componentIds,
      },
    );
  }
  const selected = new Set(componentIds);
  document.selection = {
    mode,
    objectIds: [objectId],
    componentIds: collection.filter(({ id }) => selected.has(id)).map(({ id }) => id),
    activeObjectId: objectId,
  };
  return { document, result: affectedResult(document, [objectId]) };
};

function convertedComponentIds(
  mesh: PolygonMesh,
  currentMode: SelectionMode,
  currentIds: readonly string[],
  targetMode: ComponentMode,
): string[] {
  const selected = new Set(currentIds);
  const edgeByKey = new Map(
    mesh.edges.map((edge) => {
      const [first, second] = edge.vertexIds;
      return [first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`, edge.id] as const;
    }),
  );
  const faceBoundaryEdges = (face: PolygonMesh["faces"][number]) => {
    const ids: string[] = [];
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const first = face.vertexIds[index];
      const second = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
      const edgeId = edgeByKey.get(key);
      if (edgeId) ids.push(edgeId);
    }
    return ids;
  };

  if (targetMode === "vertex") {
    if (currentMode === "vertex") return mesh.vertices.filter(({ id }) => selected.has(id)).map(({ id }) => id);
    if (currentMode === "edge") {
      const vertices = new Set(mesh.edges.filter(({ id }) => selected.has(id)).flatMap(({ vertexIds }) => vertexIds));
      return mesh.vertices.filter(({ id }) => vertices.has(id)).map(({ id }) => id);
    }
    const vertices = new Set(mesh.faces.filter(({ id }) => selected.has(id)).flatMap(({ vertexIds }) => vertexIds));
    return mesh.vertices.filter(({ id }) => vertices.has(id)).map(({ id }) => id);
  }

  if (targetMode === "edge") {
    if (currentMode === "edge") return mesh.edges.filter(({ id }) => selected.has(id)).map(({ id }) => id);
    if (currentMode === "vertex") {
      return mesh.edges.filter(({ vertexIds }) => vertexIds.some((id) => selected.has(id))).map(({ id }) => id);
    }
    const faceIds = new Set(mesh.faces.filter(({ id }) => selected.has(id)).flatMap((face) => faceBoundaryEdges(face)));
    return mesh.edges.filter(({ id }) => faceIds.has(id)).map(({ id }) => id);
  }

  if (currentMode === "face") return mesh.faces.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  if (currentMode === "vertex") {
    return mesh.faces.filter(({ vertexIds }) => vertexIds.some((id) => selected.has(id))).map(({ id }) => id);
  }
  return mesh.faces.filter((face) => faceBoundaryEdges(face).some((id) => selected.has(id))).map(({ id }) => id);
}

const setSelectionMode: CommandHandler = (document, args) => {
  const mode = args.mode as SelectionMode;
  const conversion = args.conversion as "convert" | "clear";
  const current = document.selection;

  if (mode === "object") {
    const objectIds =
      conversion === "clear"
        ? []
        : current.mode === "object"
          ? [...current.objectIds]
          : current.activeObjectId
            ? [current.activeObjectId]
            : [];
    const activeObjectId = objectIds.includes(current.activeObjectId ?? "")
      ? current.activeObjectId
      : (objectIds.at(-1) ?? null);
    document.selection = { mode, objectIds, componentIds: [], activeObjectId };
    return { document, result: affectedResult(document, objectIds) };
  }

  const objectId =
    current.mode === "object" ? (current.activeObjectId ?? current.objectIds.at(-1)) : current.activeObjectId;
  const object = document.objects.find(({ id }) => id === objectId);
  if (
    !object?.mesh ||
    !document.scenes.find(({ id }) => id === document.activeSceneId)?.objectIds.includes(object.id)
  ) {
    throw new ModelingContractError("operation-ineligible", "Component mode requires an active editable mesh object.", {
      objectId: objectId ?? null,
      targetMode: mode,
    });
  }
  const collection = mode === "vertex" ? object.mesh.vertices : mode === "edge" ? object.mesh.edges : object.mesh.faces;
  let componentIds: string[];
  if (conversion === "clear") {
    componentIds = [];
  } else if (current.mode === "object") {
    componentIds = collection.map(({ id }) => id);
  } else {
    componentIds = convertedComponentIds(object.mesh, current.mode, current.componentIds, mode);
  }
  document.selection = {
    mode,
    objectIds: [object.id],
    componentIds,
    activeObjectId: object.id,
  };
  return { document, result: affectedResult(document, [object.id]) };
};

function selectedVertexIds(document: ModelingDocument, mode: ComponentMode): Set<string> {
  const objectId = document.selection.activeObjectId;
  const object = document.objects.find(({ id }) => id === objectId);
  if (!object?.mesh || document.selection.mode !== mode) {
    throw new ModelingContractError(
      "operation-ineligible",
      "The active selection does not match the requested mesh component mode.",
      {
        objectId,
        requestedMode: mode,
        selectionMode: document.selection.mode,
      },
    );
  }
  const mesh = object.mesh;
  const selected = new Set(document.selection.componentIds);
  if (mode === "vertex") return selected;
  const components = mode === "edge" ? mesh.edges : mesh.faces;
  const vertices = new Set<string>();
  for (const component of components) {
    if (!selected.has(component.id)) continue;
    for (const vertexId of component.vertexIds) vertices.add(vertexId);
  }
  return vertices;
}

function rotateEulerXYZ(point: Vec3, angles: Vec3): Vec3 {
  const [x, y, z] = angles;
  const [sinX, cosX] = [Math.sin(x), Math.cos(x)];
  const [sinY, cosY] = [Math.sin(y), Math.cos(y)];
  const [sinZ, cosZ] = [Math.sin(z), Math.cos(z)];
  const afterX: Vec3 = [point[0], cosX * point[1] - sinX * point[2], sinX * point[1] + cosX * point[2]];
  const afterY: Vec3 = [cosY * afterX[0] + sinY * afterX[2], afterX[1], -sinY * afterX[0] + cosY * afterX[2]];
  return [cosZ * afterY[0] - sinZ * afterY[1], sinZ * afterY[0] + cosZ * afterY[1], afterY[2]];
}

const transformComponents: CommandHandler = (document, args) => {
  const object = document.objects.find(({ id }) => id === args.objectId);
  if (!object?.mesh) {
    throw new ModelingContractError("not-found", "The target editable mesh does not exist.", {
      entityType: "mesh",
      entityId: args.objectId,
    });
  }
  const mode = args.mode as ComponentMode;
  const vertexIds = selectedVertexIds(document, mode);
  const vertices = object.mesh.vertices.filter(({ id }) => vertexIds.has(id));
  if (vertices.length === 0) {
    throw new ModelingContractError("operation-ineligible", "The component transform selection contains no vertices.", {
      objectId: object.id,
      mode,
    });
  }
  const value = args.value as Vec3;
  const pivot = (args.pivot as Vec3 | undefined) ?? [
    vertices.reduce((sum, vertex) => sum + vertex.position[0], 0) / vertices.length,
    vertices.reduce((sum, vertex) => sum + vertex.position[1], 0) / vertices.length,
    vertices.reduce((sum, vertex) => sum + vertex.position[2], 0) / vertices.length,
  ];
  for (const vertex of vertices) {
    const relative: Vec3 = [
      vertex.position[0] - pivot[0],
      vertex.position[1] - pivot[1],
      vertex.position[2] - pivot[2],
    ];
    let transformed: Vec3;
    if (args.operation === "translate") {
      transformed = [vertex.position[0] + value[0], vertex.position[1] + value[1], vertex.position[2] + value[2]];
    } else if (args.operation === "rotate") {
      const rotated = rotateEulerXYZ(relative, value);
      transformed = [rotated[0] + pivot[0], rotated[1] + pivot[1], rotated[2] + pivot[2]];
    } else {
      transformed = [
        relative[0] * value[0] + pivot[0],
        relative[1] * value[1] + pivot[1],
        relative[2] * value[2] + pivot[2],
      ];
    }
    vertex.position = transformed;
  }
  return { document, result: affectedResult(document, [object.id]) };
};

export function createCoreCommandHandlers(): Readonly<Record<string, CommandHandler>> {
  return {
    "document.rename": (document, args) => {
      const name = (args.name as string).trim();
      if (!name) throw new ModelingContractError("invalid-arguments", "Project name cannot be blank.");
      document.name = name;
      return { document, result: affectedResult(document, []) };
    },
    "scene.createPrimitive": createPrimitive,
    "object.rename": renameObject,
    "object.duplicate": duplicateObject,
    "object.setVisibility": setObjectVisibility,
    "object.delete": deleteObjects,
    "object.setTransform": setObjectTransform,
    "selection.setObjects": setObjectSelection,
    "selection.setComponents": setComponentSelection,
    "selection.setMode": setSelectionMode,
    "mesh.transformComponents": transformComponents,
    "mesh.extrude": extrudeComponents,
    "mesh.insetFaces": insetFaces,
    "mesh.mergeVertices": mergeSelectedVertices,
    "mesh.dissolveEdges": dissolveSelectedEdges,
    "mesh.dissolveFaces": dissolveSelectedFaces,
    "mesh.bevelEdges": bevelSelectedEdges,
    "mesh.loopCut": cutQuadLoop,
    "mesh.recalculateNormals": recalculateNormals,
    "mesh.flipNormals": flipSelectedNormals,
  };
}