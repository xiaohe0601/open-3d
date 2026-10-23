import type { MeshEdge, MeshFace, PolygonMesh, Vec3 } from "./document.ts";

const EPSILON = 1e-10;

export function meshEdgeKey(first: string, second: string): string {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}

export function edgeIncidence(mesh: PolygonMesh): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const key = meshEdgeKey(face.vertexIds[index], face.vertexIds[(index + 1) % face.vertexIds.length]);
      const incident = result.get(key) ?? [];
      incident.push(face.id);
      result.set(key, incident);
    }
  }
  return result;
}

export function normalizedDirection(direction: Vec3): Vec3 | null {
  const length = Math.hypot(...direction);
  if (!Number.isFinite(length) || length <= EPSILON) return null;
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(vector: Vec3): Vec3 | null {
  const length = Math.hypot(...vector);
  if (length <= EPSILON) return null;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function faceNormal(face: MeshFace, positions: Map<string, Vec3>): Vec3 | null {
  let normal: Vec3 = [0, 0, 0];
  for (let index = 0; index < face.vertexIds.length; index += 1) {
    const current = positions.get(face.vertexIds[index])!;
    const next = positions.get(face.vertexIds[(index + 1) % face.vertexIds.length])!;
    normal = [
      normal[0] + (current[1] - next[1]) * (current[2] + next[2]),
      normal[1] + (current[2] - next[2]) * (current[0] + next[0]),
      normal[2] + (current[0] - next[0]) * (current[1] + next[1]),
    ];
  }
  return normalize3(normal);
}

function cross2(a: [number, number], b: [number, number]): number {
  return a[0] * b[1] - a[1] * b[0];
}

function signedArea(points: readonly [number, number][]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return cross2([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]);
}

function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const onSegment = (start: [number, number], end: [number, number], point: [number, number]) =>
    point[0] >= Math.min(start[0], end[0]) - EPSILON &&
    point[0] <= Math.max(start[0], end[0]) + EPSILON &&
    point[1] >= Math.min(start[1], end[1]) - EPSILON &&
    point[1] <= Math.max(start[1], end[1]) + EPSILON;
  if (abC * abD < -EPSILON && cdA * cdB < -EPSILON) return true;
  return (
    (Math.abs(abC) <= EPSILON && onSegment(a, b, c)) ||
    (Math.abs(abD) <= EPSILON && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= EPSILON && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= EPSILON && onSegment(c, d, b))
  );
}

function isSimplePolygon(points: readonly [number, number][]): boolean {
  if (
    points.some((point, index) => {
      const next = points[(index + 1) % points.length];
      return Math.hypot(point[0] - next[0], point[1] - next[1]) <= EPSILON;
    })
  )
    return false;
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return false;
    }
  }
  return true;
}

export interface InsetBoundary {
  vertexIds: string[];
  positions: Map<string, Vec3>;
}

export interface InsetAnalysis {
  eligible: boolean;
  reason?: "simple-boundary-required" | "non-planar-region" | "degenerate-face" | "inset-collapses-face";
  boundary?: InsetBoundary;
}

export interface DissolveAnalysis {
  eligible: boolean;
  reason?: "simple-boundary-required" | "degenerate-face";
  boundary?: string[];
}

export interface BevelEndpoint {
  vertexId: string;
  pointsByAdjacentFace: Map<string, Vec3>;
  adjacentEdgeByFace: Map<string, string>;
  cornerFaceId: string;
}

export interface BevelAnalysis {
  eligible: boolean;
  reason?: "boundary-edge" | "non-manifold-edge" | "bevel-collapses-face" | "bevel-junction";
  adjacentFaceIds?: [string, string];
  endpoints?: [BevelEndpoint, BevelEndpoint];
}

export interface NormalAnalysis {
  eligible: boolean;
  reason?:
    | "selection-empty"
    | "ambiguous-component"
    | "boundary-edge"
    | "non-manifold-edge"
    | "degenerate-face"
    | "non-orientable"
    | "zero-volume";
  faceIds?: string[];
  facesToFlip?: string[];
}

function faceAreaVector(face: MeshFace, positions: Map<string, Vec3>): Vec3 {
  let area: Vec3 = [0, 0, 0];
  for (let index = 0; index < face.vertexIds.length; index += 1) {
    const current = positions.get(face.vertexIds[index])!;
    const next = positions.get(face.vertexIds[(index + 1) % face.vertexIds.length])!;
    area = [
      area[0] + current[1] * next[2] - current[2] * next[1],
      area[1] + current[2] * next[0] - current[0] * next[2],
      area[2] + current[0] * next[1] - current[1] * next[0],
    ];
  }
  return area;
}

function faceEdgeDirections(face: MeshFace): Map<string, number> {
  const directions = new Map<string, number>();
  for (let index = 0; index < face.vertexIds.length; index += 1) {
    const first = face.vertexIds[index];
    const second = face.vertexIds[(index + 1) % face.vertexIds.length];
    const key = meshEdgeKey(first, second);
    directions.set(key, first < second ? 1 : -1);
  }
  return directions;
}

export function analyzeNormalRecalculation(mesh: PolygonMesh, seedFaceId?: string): NormalAnalysis {
  if (mesh.faces.length === 0) return { eligible: false, reason: "selection-empty" };
  const faceById = new Map(mesh.faces.map((face) => [face.id, face]));
  if (seedFaceId && !faceById.has(seedFaceId)) return { eligible: false, reason: "selection-empty" };

  const faceEdges = new Map(mesh.faces.map((face) => [face.id, faceEdgeDirections(face)]));
  const adjacency = new Map<string, Array<{ faceId: string; sameDirection: boolean }>>();
  const edgeFaces = new Map<string, string[]>();
  for (const [faceId, directions] of faceEdges) {
    for (const edgeKey of directions.keys()) {
      const faces = edgeFaces.get(edgeKey) ?? [];
      faces.push(faceId);
      edgeFaces.set(edgeKey, faces);
    }
  }
  for (const [edgeKey, incidentIds] of edgeFaces) {
    if (incidentIds.length !== 2) continue;
    const [firstId, secondId] = incidentIds;
    const sameDirection = faceEdges.get(firstId)!.get(edgeKey) === faceEdges.get(secondId)!.get(edgeKey);
    adjacency.set(firstId, [...(adjacency.get(firstId) ?? []), { faceId: secondId, sameDirection }]);
    adjacency.set(secondId, [...(adjacency.get(secondId) ?? []), { faceId: firstId, sameDirection }]);
  }

  const components: string[][] = [];
  const unseen = new Set(faceById.keys());
  while (unseen.size > 0) {
    const start = unseen.values().next().value as string;
    const component: string[] = [];
    const pending = [start];
    while (pending.length > 0) {
      const faceId = pending.pop()!;
      if (!unseen.delete(faceId)) continue;
      component.push(faceId);
      for (const neighbor of adjacency.get(faceId) ?? []) pending.push(neighbor.faceId);
    }
    components.push(component);
  }
  const component = seedFaceId
    ? components.find((ids) => ids.includes(seedFaceId))
    : components.length === 1
      ? components[0]
      : undefined;
  if (!component) return { eligible: false, reason: "ambiguous-component" };
  const componentSet = new Set(component);

  for (const [edgeKey, incidentIds] of edgeFaces) {
    if (!incidentIds.some((id) => componentSet.has(id))) continue;
    if (incidentIds.length > 2) return { eligible: false, reason: "non-manifold-edge" };
    if (incidentIds.length !== 2) {
      return { eligible: false, reason: incidentIds.length > 2 ? "non-manifold-edge" : "boundary-edge" };
    }
    if (incidentIds.some((id) => !componentSet.has(id))) {
      return { eligible: false, reason: "ambiguous-component" };
    }
    void edgeKey;
  }

  const positions = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex.position]));
  const flipByFace = new Map<string, boolean>();
  for (const start of component) {
    if (flipByFace.has(start)) continue;
    flipByFace.set(start, false);
    const pending = [start];
    while (pending.length > 0) {
      const faceId = pending.pop()!;
      const currentFlip = flipByFace.get(faceId)!;
      for (const neighbor of adjacency.get(faceId) ?? []) {
        if (!componentSet.has(neighbor.faceId)) continue;
        const requiredFlip = currentFlip !== neighbor.sameDirection;
        const known = flipByFace.get(neighbor.faceId);
        if (known !== undefined && known !== requiredFlip) {
          return { eligible: false, reason: "non-orientable" };
        }
        if (known === undefined) {
          flipByFace.set(neighbor.faceId, requiredFlip);
          pending.push(neighbor.faceId);
        }
      }
    }
  }

  for (const faceId of component) {
    if (Math.hypot(...faceAreaVector(faceById.get(faceId)!, positions)) <= EPSILON) {
      return { eligible: false, reason: "degenerate-face" };
    }
  }
  let signedVolume = 0;
  for (const faceId of component) {
    const face = faceById.get(faceId)!;
    const ids = flipByFace.get(faceId) ? [...face.vertexIds].reverse() : face.vertexIds;
    const origin = positions.get(ids[0])!;
    for (let index = 1; index < ids.length - 1; index += 1) {
      const a = subtract(positions.get(ids[index])!, origin);
      const b = subtract(positions.get(ids[index + 1])!, origin);
      signedVolume += dot3(origin, cross3(a, b)) / 6;
    }
  }
  if (Math.abs(signedVolume) <= EPSILON) return { eligible: false, reason: "zero-volume" };
  const invert = signedVolume < 0;
  const facesToFlip = component.filter((id) => flipByFace.get(id)! !== invert);
  return { eligible: true, faceIds: component, facesToFlip };
}

function selectedBoundaryLoop(mesh: PolygonMesh, selectedFaces: readonly MeshFace[]): string[] | null {
  const selectedFaceIds = new Set(selectedFaces.map(({ id }) => id));
  const allIncidence = new Map<string, { faces: string[]; oriented: Array<[string, string]> }>();
  for (const face of mesh.faces) {
    for (let index = 0; index < face.vertexIds.length; index += 1) {
      const first = face.vertexIds[index];
      const second = face.vertexIds[(index + 1) % face.vertexIds.length];
      const key = meshEdgeKey(first, second);
      const entry = allIncidence.get(key) ?? { faces: [], oriented: [] };
      entry.faces.push(face.id);
      if (selectedFaceIds.has(face.id)) entry.oriented.push([first, second]);
      allIncidence.set(key, entry);
    }
  }
  const directedBoundary: Array<[string, string]> = [];
  for (const entry of allIncidence.values()) {
    if (entry.oriented.length === 1) {
      if (entry.faces.length > 2) return null;
      directedBoundary.push(entry.oriented[0]);
    } else if (entry.oriented.length > 2) {
      return null;
    }
  }
  if (directedBoundary.length < 3) return null;

  const outgoing = new Map<string, string>();
  const incoming = new Map<string, number>();
  for (const [first, second] of directedBoundary) {
    if (outgoing.has(first)) return null;
    outgoing.set(first, second);
    incoming.set(second, (incoming.get(second) ?? 0) + 1);
  }
  if ([...outgoing.keys()].some((id) => incoming.get(id) !== 1)) return null;
  const start = directedBoundary[0][0];
  const loop = [start];
  let current = outgoing.get(start);
  while (current && current !== start && loop.length <= directedBoundary.length) {
    loop.push(current);
    current = outgoing.get(current);
  }
  if (current !== start || loop.length !== directedBoundary.length) return null;
  return loop;
}

export function connectedFaceGroups(
  mesh: PolygonMesh,
  selectedFaces: readonly MeshFace[],
  connectingEdgeKeys?: ReadonlySet<string>,
): MeshFace[][] {
  const selectedIds = new Set(selectedFaces.map(({ id }) => id));
  const incidence = edgeIncidence(mesh);
  const neighbors = new Map<string, Set<string>>();
  for (const [edgeKey, incidentFaceIds] of incidence) {
    if (connectingEdgeKeys && !connectingEdgeKeys.has(edgeKey)) continue;
    const selectedIncident = incidentFaceIds.filter((id) => selectedIds.has(id));
    for (const first of selectedIncident) {
      const adjacent = neighbors.get(first) ?? new Set<string>();
      for (const second of selectedIncident) if (second !== first) adjacent.add(second);
      neighbors.set(first, adjacent);
    }
  }
  const byId = new Map(selectedFaces.map((face) => [face.id, face]));
  const groups: MeshFace[][] = [];
  const visited = new Set<string>();
  for (const face of selectedFaces) {
    if (visited.has(face.id)) continue;
    const group: MeshFace[] = [];
    const pending = [face.id];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const current = byId.get(id);
      if (current) group.push(current);
      pending.push(...(neighbors.get(id) ?? []));
    }
    groups.push(group);
  }
  return groups;
}

export function analyzeDissolveRegion(mesh: PolygonMesh, selectedFaces: readonly MeshFace[]): DissolveAnalysis {
  if (selectedFaces.length === 0) return { eligible: false, reason: "simple-boundary-required" };
  const boundary = selectedBoundaryLoop(mesh, selectedFaces);
  if (!boundary) return { eligible: false, reason: "simple-boundary-required" };
  const positions = new Map(mesh.vertices.map(({ id, position }) => [id, position]));
  const normal = faceNormal(selectedFaces[0], positions);
  if (!normal) return { eligible: false, reason: "degenerate-face" };
  const origin = positions.get(boundary[0])!;
  let basisU: Vec3 | null = null;
  for (let index = 0; index < boundary.length && !basisU; index += 1) {
    basisU = normalize3(
      subtract(positions.get(boundary[(index + 1) % boundary.length])!, positions.get(boundary[index])!),
    );
  }
  if (!basisU) return { eligible: false, reason: "degenerate-face" };
  const basisV = normalize3(cross3(normal, basisU));
  if (!basisV) return { eligible: false, reason: "degenerate-face" };
  const points = boundary.map((id) => {
    const relative = subtract(positions.get(id)!, origin);
    return [dot3(relative, basisU!), dot3(relative, basisV!)] as [number, number];
  });
  if (Math.abs(signedArea(points)) <= EPSILON) return { eligible: false, reason: "degenerate-face" };
  if (!isSimplePolygon(points)) return { eligible: false, reason: "simple-boundary-required" };
  return { eligible: true, boundary };
}

export function analyzeBevelEdge(mesh: PolygonMesh, edge: MeshEdge, width: number): BevelAnalysis {
  const [startId, endId] = edge.vertexIds;
  const incidence = edgeIncidence(mesh);
  const targetKey = meshEdgeKey(startId, endId);
  const adjacentFaceIds = incidence.get(targetKey) ?? [];
  if (adjacentFaceIds.length !== 2) {
    return { eligible: false, reason: adjacentFaceIds.length > 2 ? "non-manifold-edge" : "boundary-edge" };
  }

  const endpointFaceIds = new Map<string, Set<string>>();
  for (const face of mesh.faces) {
    for (const vertexId of face.vertexIds) {
      const faces = endpointFaceIds.get(vertexId) ?? new Set<string>();
      faces.add(face.id);
      endpointFaceIds.set(vertexId, faces);
    }
  }
  const positions = new Map(mesh.vertices.map(({ id, position }) => [id, position]));
  const adjacentFaces = adjacentFaceIds.map((id) => mesh.faces.find((face) => face.id === id)!);
  const endpointResults: BevelEndpoint[] = [];
  const faceNormals = adjacentFaces.map((face) => faceNormal(face, positions));
  if (faceNormals.some((normal) => !normal)) return { eligible: false, reason: "bevel-collapses-face" };
  for (const vertexId of [startId, endId]) {
    const incidentFaces = endpointFaceIds.get(vertexId) ?? new Set<string>();
    const cornerFaces = [...incidentFaces].filter((id) => !adjacentFaceIds.includes(id));
    if (incidentFaces.size !== 3 || cornerFaces.length !== 1) {
      return { eligible: false, reason: "bevel-junction" };
    }
    const pointsByAdjacentFace = new Map<string, Vec3>();
    const adjacentEdgeByFace = new Map<string, string>();
    for (const face of adjacentFaces) {
      const index = face.vertexIds.indexOf(vertexId);
      if (index < 0) return { eligible: false, reason: "bevel-junction" };
      const previousId = face.vertexIds[(index + face.vertexIds.length - 1) % face.vertexIds.length];
      const nextId = face.vertexIds[(index + 1) % face.vertexIds.length];
      const neighborId =
        previousId === (vertexId === startId ? endId : startId)
          ? nextId
          : nextId === (vertexId === startId ? endId : startId)
            ? previousId
            : null;
      if (!neighborId) return { eligible: false, reason: "bevel-junction" };
      const origin = positions.get(vertexId)!;
      const neighbor = positions.get(neighborId)!;
      const vector = subtract(neighbor, origin);
      const length = Math.hypot(...vector);
      if (length <= EPSILON || width >= length - EPSILON) {
        return { eligible: false, reason: "bevel-collapses-face" };
      }
      pointsByAdjacentFace.set(face.id, [
        origin[0] + (vector[0] / length) * width,
        origin[1] + (vector[1] / length) * width,
        origin[2] + (vector[2] / length) * width,
      ]);
      adjacentEdgeByFace.set(face.id, meshEdgeKey(vertexId, neighborId));
    }
    const cornerFace = mesh.faces.find(({ id }) => id === cornerFaces[0])!;
    const previousId =
      cornerFace.vertexIds[
        (cornerFace.vertexIds.indexOf(vertexId) + cornerFace.vertexIds.length - 1) % cornerFace.vertexIds.length
      ];
    const nextId = cornerFace.vertexIds[(cornerFace.vertexIds.indexOf(vertexId) + 1) % cornerFace.vertexIds.length];
    const previousKey = meshEdgeKey(previousId, vertexId);
    const nextKey = meshEdgeKey(vertexId, nextId);
    const previousFaceId = [...adjacentEdgeByFace].find(([, key]) => key === previousKey)?.[0];
    const nextFaceId = [...adjacentEdgeByFace].find(([, key]) => key === nextKey)?.[0];
    if (!previousFaceId || !nextFaceId || previousFaceId === nextFaceId) {
      return { eligible: false, reason: "bevel-junction" };
    }
    endpointResults.push({
      vertexId,
      pointsByAdjacentFace,
      adjacentEdgeByFace,
      cornerFaceId: cornerFace.id,
    });
  }
  return {
    eligible: true,
    adjacentFaceIds: adjacentFaceIds as [string, string],
    endpoints: endpointResults as [BevelEndpoint, BevelEndpoint],
  };
}

export function analyzeQuadLoop(
  mesh: PolygonMesh,
  seedEdgeId: string,
): {
  eligible: boolean;
  reason?: "loop-reaches-boundary" | "non-quad-face" | "non-manifold-edge" | "degenerate-face" | "ambiguous-loop";
  edgeIds?: string[];
  faceIds?: string[];
  crossedByFace?: Map<string, [string, string]>;
} {
  const edgesByKey = new Map(mesh.edges.map((edge) => [meshEdgeKey(edge.vertexIds[0], edge.vertexIds[1]), edge]));
  const edgeById = new Map(mesh.edges.map((edge) => [edge.id, edge]));
  const incidence = edgeIncidence(mesh);
  const pending = [seedEdgeId];
  const visitedEdges = new Set<string>();
  const crossedByFace = new Map<string, [string, string]>();
  const faceIds = new Set<string>();

  while (pending.length > 0) {
    const edgeId = pending.pop()!;
    if (visitedEdges.has(edgeId)) continue;
    const edge = edgeById.get(edgeId);
    if (!edge) return { eligible: false, reason: "ambiguous-loop" };
    const edgeKey = meshEdgeKey(edge.vertexIds[0], edge.vertexIds[1]);
    const incidentIds = incidence.get(edgeKey) ?? [];
    if (incidentIds.length !== 2) {
      return { eligible: false, reason: incidentIds.length > 2 ? "non-manifold-edge" : "loop-reaches-boundary" };
    }
    visitedEdges.add(edgeId);
    for (const faceId of incidentIds) {
      const face = mesh.faces.find(({ id }) => id === faceId)!;
      if (face.vertexIds.length !== 4) return { eligible: false, reason: "non-quad-face" };
      const startIndex = face.vertexIds.findIndex(
        (vertexId, index) => meshEdgeKey(vertexId, face.vertexIds[(index + 1) % 4]) === edgeKey,
      );
      if (startIndex < 0) return { eligible: false, reason: "ambiguous-loop" };
      const opposite = meshEdgeKey(face.vertexIds[(startIndex + 2) % 4], face.vertexIds[(startIndex + 3) % 4]);
      const oppositeEdge = edgesByKey.get(opposite);
      if (!oppositeEdge) return { eligible: false, reason: "ambiguous-loop" };
      const previous = crossedByFace.get(faceId);
      if (previous && !previous.includes(edgeId)) return { eligible: false, reason: "ambiguous-loop" };
      crossedByFace.set(faceId, [edgeId, oppositeEdge.id]);
      faceIds.add(faceId);
      if (!visitedEdges.has(oppositeEdge.id)) pending.push(oppositeEdge.id);
    }
  }
  if (visitedEdges.size < 3 || [...crossedByFace.values()].some(([first, second]) => first === second)) {
    return { eligible: false, reason: "ambiguous-loop" };
  }
  const loopNeighbors = new Map<string, Set<string>>();
  for (const [first, second] of crossedByFace.values()) {
    const firstNeighbors = loopNeighbors.get(first) ?? new Set<string>();
    firstNeighbors.add(second);
    loopNeighbors.set(first, firstNeighbors);
    const secondNeighbors = loopNeighbors.get(second) ?? new Set<string>();
    secondNeighbors.add(first);
    loopNeighbors.set(second, secondNeighbors);
  }
  if (loopNeighbors.size !== visitedEdges.size || [...loopNeighbors.values()].some((neighbors) => neighbors.size !== 2))
    return { eligible: false, reason: "ambiguous-loop" };
  const selectedSet = new Set(visitedEdges);
  for (const faceId of faceIds) {
    const [first, second] = crossedByFace.get(faceId)!;
    if (!selectedSet.has(first) || !selectedSet.has(second)) return { eligible: false, reason: "ambiguous-loop" };
  }
  return {
    eligible: true,
    edgeIds: [...visitedEdges],
    faceIds: [...faceIds],
    crossedByFace,
  };
}

export function analyzeInset(mesh: PolygonMesh, selectedFaces: readonly MeshFace[], offset: number): InsetAnalysis {
  if (selectedFaces.length === 0) return { eligible: false, reason: "degenerate-face" };
  const positions = new Map(mesh.vertices.map(({ id, position }) => [id, position]));
  const normal = faceNormal(selectedFaces[0], positions);
  if (!normal) return { eligible: false, reason: "degenerate-face" };
  const origin = positions.get(selectedFaces[0].vertexIds[0])!;
  if (
    mesh.vertices.some(
      ({ id, position }) =>
        selectedFaces.some((face) => face.vertexIds.includes(id)) &&
        Math.abs(dot3(subtract(position, origin), normal)) > 1e-6,
    )
  ) {
    return { eligible: false, reason: "non-planar-region" };
  }
  for (const face of selectedFaces) {
    const candidateNormal = faceNormal(face, positions);
    if (!candidateNormal || Math.abs(dot3(candidateNormal, normal)) < 1 - 1e-6) {
      return { eligible: false, reason: candidateNormal ? "non-planar-region" : "degenerate-face" };
    }
  }

  const loop = selectedBoundaryLoop(mesh, selectedFaces);
  if (!loop) return { eligible: false, reason: "simple-boundary-required" };
  let basisU: Vec3 | null = null;
  for (let index = 0; index < loop.length && !basisU; index += 1) {
    basisU = normalize3(subtract(positions.get(loop[(index + 1) % loop.length])!, positions.get(loop[index])!));
  }
  if (!basisU) return { eligible: false, reason: "degenerate-face" };
  const basisV = normalize3(cross3(normal, basisU));
  if (!basisV) return { eligible: false, reason: "degenerate-face" };
  const project = (point: Vec3): [number, number] => {
    const relative = subtract(point, origin);
    return [dot3(relative, basisU!), dot3(relative, basisV!)];
  };
  const points = loop.map((id) => project(positions.get(id)!));
  const area = signedArea(points);
  if (Math.abs(area) <= EPSILON || !isSimplePolygon(points)) {
    return { eligible: false, reason: "simple-boundary-required" };
  }
  const winding = Math.sign(area);
  const shiftedLines = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next[0] - point[0];
    const dy = next[1] - point[1];
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) return null;
    return {
      point: [point[0] - ((winding * dy) / length) * offset, point[1] + ((winding * dx) / length) * offset] as [
        number,
        number,
      ],
      direction: [dx, dy] as [number, number],
    };
  });
  if (shiftedLines.some((line) => line === null)) return { eligible: false, reason: "degenerate-face" };
  const insetPoints: [number, number][] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = shiftedLines[(index + points.length - 1) % points.length]!;
    const current = shiftedLines[index]!;
    const denominator = cross2(previous.direction, current.direction);
    if (Math.abs(denominator) <= EPSILON) {
      insetPoints.push([(previous.point[0] + current.point[0]) / 2, (previous.point[1] + current.point[1]) / 2]);
      continue;
    }
    const delta: [number, number] = [current.point[0] - previous.point[0], current.point[1] - previous.point[1]];
    const t = cross2(delta, current.direction) / denominator;
    insetPoints.push([previous.point[0] + t * previous.direction[0], previous.point[1] + t * previous.direction[1]]);
  }
  const insetArea = signedArea(insetPoints);
  if (
    Math.abs(insetArea) <= EPSILON ||
    Math.sign(insetArea) !== winding ||
    !isSimplePolygon(insetPoints) ||
    insetPoints.some((point, index) => {
      const originalEdge: [number, number] = [
        points[(index + 1) % points.length][0] - points[index][0],
        points[(index + 1) % points.length][1] - points[index][1],
      ];
      const insetEdge: [number, number] = [
        insetPoints[(index + 1) % insetPoints.length][0] - point[0],
        insetPoints[(index + 1) % insetPoints.length][1] - point[1],
      ];
      return originalEdge[0] * insetEdge[0] + originalEdge[1] * insetEdge[1] <= EPSILON;
    })
  ) {
    return { eligible: false, reason: "inset-collapses-face" };
  }
  const insetPositions = new Map<string, Vec3>();
  for (let index = 0; index < loop.length; index += 1) {
    const [x, y] = insetPoints[index];
    insetPositions.set(loop[index], [
      origin[0] + basisU[0] * x + basisV[0] * y,
      origin[1] + basisU[1] * x + basisV[1] * y,
      origin[2] + basisU[2] * x + basisV[2] * y,
    ]);
  }
  for (const face of selectedFaces) {
    const mapped = face.vertexIds.map((id) => insetPositions.get(id) ?? positions.get(id)!);
    let twiceArea = 0;
    for (let index = 1; index < mapped.length - 1; index += 1) {
      twiceArea += Math.hypot(...cross3(subtract(mapped[index], mapped[0]), subtract(mapped[index + 1], mapped[0])));
    }
    if (twiceArea / 2 <= EPSILON) return { eligible: false, reason: "inset-collapses-face" };
  }
  return {
    eligible: true,
    boundary: { vertexIds: loop, positions: insetPositions },
  };
}