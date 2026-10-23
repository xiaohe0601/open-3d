export function createWorkspaceDocument(objectCount = 1, gridSize = 1) {
  const objects = [];
  const objectIds = [];
  for (let index = 0; index < objectCount; index += 1) {
    const objectId = `object-${index}`;
    objectIds.push(objectId);
    objects.push({
      id: objectId,
      name: `Object ${index}`,
      transform: {
        position: [index % 10, Math.floor(index / 10), 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      mesh: gridSize === 0 ? createBoxMesh(objectId) : createQuadMesh(objectId, gridSize),
      visible: true,
      parentId: null,
    });
  }

  return {
    schemaVersion: 1,
    id: "workspace-benchmark",
    name: "Workspace benchmark",
    activeSceneId: "scene-main",
    scenes: [{ id: "scene-main", name: "Scene", objectIds }],
    objects,
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
}

function createBoxMesh(prefix) {
  const coordinates = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ];
  const faceIndices = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const vertices = coordinates.map((position, index) => ({ id: `${prefix}-v-${index}`, position }));
  const edges = new Map();
  const faces = faceIndices.map((indices, faceIndex) => {
    const vertexIds = indices.map((index) => vertices[index].id);
    for (let index = 0; index < vertexIds.length; index += 1) {
      const start = vertexIds[index];
      const end = vertexIds[(index + 1) % vertexIds.length];
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      if (!edges.has(key)) edges.set(key, { id: `${prefix}-e-${edges.size}`, vertexIds: [start, end] });
    }
    return { id: `${prefix}-f-${faceIndex}`, vertexIds, materialId: null };
  });
  return { id: `${prefix}-mesh`, vertices, edges: [...edges.values()], faces };
}

function createQuadMesh(prefix, size) {
  const vertices = [];
  const faces = [];
  const edges = new Map();
  for (let y = 0; y <= size; y += 1) {
    for (let x = 0; x <= size; x += 1) {
      vertices.push({ id: `${prefix}-v-${y * (size + 1) + x}`, position: [x, y, 0] });
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const a = y * (size + 1) + x;
      const b = a + 1;
      const d = (y + 1) * (size + 1) + x;
      const c = d + 1;
      const vertexIds = [a, b, c, d].map((index) => vertices[index].id);
      faces.push({ id: `${prefix}-f-${y * size + x}`, vertexIds, materialId: null });
      for (let index = 0; index < vertexIds.length; index += 1) {
        const start = vertexIds[index];
        const end = vertexIds[(index + 1) % vertexIds.length];
        const key = start < end ? `${start}:${end}` : `${end}:${start}`;
        if (!edges.has(key)) edges.set(key, { id: `${prefix}-e-${edges.size}`, vertexIds: [start, end] });
      }
    }
  }
  return { id: `${prefix}-mesh`, vertices, edges: [...edges.values()], faces };
}