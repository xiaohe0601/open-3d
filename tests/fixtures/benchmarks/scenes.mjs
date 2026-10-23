export const benchmarkDefinitions = {
  primitiveScene: {
    objectCount: 100,
    primitive: "box",
  },
  editableQuad: {
    width: 16,
    height: 16,
  },
  denseMesh: {
    width: 128,
    height: 128,
  },
};

export function createQuadGrid(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Grid dimensions must be positive integers.");
  }

  const vertices = [];
  const faces = [];

  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      vertices.push([x, y, 0]);
    }
  }

  const rowLength = width + 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = y * rowLength + x;
      const b = a + 1;
      const d = (y + 1) * rowLength + x;
      const c = d + 1;
      faces.push([a, b, c, d]);
    }
  }

  return { vertices, faces };
}

export function createPrimitiveScene(objectCount = benchmarkDefinitions.primitiveScene.objectCount) {
  if (!Number.isInteger(objectCount) || objectCount < 1) {
    throw new RangeError("Object count must be a positive integer.");
  }

  return {
    objects: Array.from({ length: objectCount }, (_, index) => ({
      id: `box-${String(index + 1).padStart(4, "0")}`,
      primitive: "box",
      position: [index % 10, Math.floor(index / 10), 0],
    })),
  };
}

export function createInterchangeScene() {
  return {
    assetVersion: "2.0",
    scene: {
      name: "interchange-baseline",
      nodes: [
        {
          name: "root",
          children: [
            {
              name: "box",
              mesh: 0,
              translation: [1, 2, 3],
            },
          ],
        },
      ],
      meshes: [
        {
          primitives: [
            {
              positions: [
                [-0.5, -0.5, -0.5],
                [0.5, -0.5, -0.5],
                [0.5, 0.5, -0.5],
                [-0.5, 0.5, -0.5],
                [-0.5, -0.5, 0.5],
                [0.5, -0.5, 0.5],
                [0.5, 0.5, 0.5],
                [-0.5, 0.5, 0.5],
              ],
              indices: [
                0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4,
                7,
              ],
              material: {
                baseColorFactor: [0.8, 0.2, 0.1, 1],
                metallicFactor: 0.1,
                roughnessFactor: 0.7,
              },
            },
          ],
        },
      ],
    },
  };
}

export function createBenchmarkFixtures() {
  return {
    primitiveScene: createPrimitiveScene(),
    editableQuad: createQuadGrid(benchmarkDefinitions.editableQuad.width, benchmarkDefinitions.editableQuad.height),
    denseMesh: createQuadGrid(benchmarkDefinitions.denseMesh.width, benchmarkDefinitions.denseMesh.height),
    interchange: createInterchangeScene(),
  };
}