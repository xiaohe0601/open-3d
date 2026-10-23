import { describe, expect, test } from "vite-plus/test";
import {
  componentPivot,
  createTransformCommand,
  eulerToQuaternion,
  operationArguments,
  quaternionToEuler,
} from "./modeling";
import type { ModelingDocument, ModelingObject } from "@open-3d/model-core";

function documentFixture(): ModelingDocument {
  return {
    schemaVersion: 1,
    id: "document",
    name: "Scene",
    activeSceneId: "scene",
    scenes: [{ id: "scene", name: "Scene", objectIds: ["object"] }],
    objects: [
      {
        id: "object",
        name: "Box",
        parentId: null,
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: {
          id: "mesh",
          vertices: [
            { id: "v1", position: [0, 0, 0] },
            { id: "v2", position: [2, 0, 0] },
            { id: "v3", position: [2, 2, 0] },
            { id: "v4", position: [0, 2, 0] },
          ],
          edges: [
            { id: "e1", vertexIds: ["v1", "v2"] },
            { id: "e2", vertexIds: ["v2", "v3"] },
            { id: "e3", vertexIds: ["v3", "v4"] },
            { id: "e4", vertexIds: ["v4", "v1"] },
          ],
          faces: [{ id: "f1", vertexIds: ["v1", "v2", "v3", "v4"], materialId: null }],
        },
      },
    ],
    materials: [],
    selection: { mode: "face", objectIds: ["object"], componentIds: ["f1"], activeObjectId: "object" },
    workspace: {
      projection: "perspective",
      cameraPosition: [4, 4, 4],
      cameraTarget: [0, 0, 0],
      cameraRotation: [0, 0, 0, 1],
      fieldOfView: 50,
      orthographicScale: 10,
      showGrid: true,
      showAxes: true,
    },
  };
}

describe("workspace modeling adapters", () => {
  test("converts Euler angles and quaternions without losing a round trip", () => {
    const euler = [0.3, -0.6, 1.2] as const;
    const result = quaternionToEuler(eulerToQuaternion([...euler]));
    expect(result[0]).toBeCloseTo(euler[0]);
    expect(result[1]).toBeCloseTo(euler[1]);
    expect(result[2]).toBeCloseTo(euler[2]);
  });

  test("computes a selection pivot from unique incident vertices", () => {
    const document = documentFixture();
    const object = document.objects[0] as ModelingObject;
    expect(componentPivot(document, object)).toEqual([1, 1, 0]);
    document.selection.mode = "edge";
    document.selection.componentIds = ["e1", "e2"];
    expect(componentPivot(document, object)).toEqual([4 / 3, 2 / 3, 0]);
  });

  test("maps the active component selection to the operation contract", () => {
    const args = operationArguments(documentFixture(), "mesh.extrude", {
      distance: 2,
      directionZ: 1,
    });
    expect(args).toMatchObject({
      objectId: "object",
      mode: "face",
      componentIds: ["f1"],
      distance: 2,
      direction: [0, 0, 1],
    });
  });

  test("maps every catalog operation to its command argument shape", () => {
    const document = documentFixture();
    const cases: [Parameters<typeof operationArguments>[1], Record<string, number | string | boolean>, object][] = [
      ["mesh.insetFaces", { offset: 0.25 }, { objectId: "object", faceIds: ["f1"], offset: 0.25 }],
      [
        "mesh.mergeVertices",
        { target: "last-selected" },
        { objectId: "object", vertexIds: ["f1"], target: "last-selected" },
      ],
      [
        "mesh.dissolveEdges",
        { preserveBoundary: false },
        { objectId: "object", edgeIds: ["f1"], preserveBoundary: false },
      ],
      ["mesh.dissolveFaces", {}, { objectId: "object", faceIds: ["f1"] }],
      [
        "mesh.bevelEdges",
        { width: 0.2, segments: 3 },
        { objectId: "object", edgeIds: ["f1"], width: 0.2, segments: 3 },
      ],
      [
        "mesh.loopCut",
        { edgeId: "e1", cuts: 2, position: 0.4 },
        { objectId: "object", edgeId: "e1", cuts: 2, position: 0.4 },
      ],
      ["mesh.recalculateNormals", {}, { objectId: "object", scope: "connected-component" }],
      ["mesh.flipNormals", {}, { objectId: "object", faceIds: ["f1"] }],
    ];

    for (const [operation, values, expected] of cases) {
      expect(operationArguments(document, operation, values)).toMatchObject(expected);
    }
  });

  test("builds snapped, axis-constrained transform commands without mutating the source", () => {
    const document = documentFixture();
    document.selection.mode = "object";
    document.selection.componentIds = [];
    const command = createTransformCommand(document, [1.23, 2, -3], {
      operation: "translate",
      axis: 0,
      snap: true,
      snapStep: 0.1,
    });

    expect(command).toMatchObject({
      commandId: "object.setTransform",
      arguments: {
        objectId: "object",
        transform: { position: [1.2, 0, 0] },
      },
    });
    expect(document.objects[0]?.transform.position).toEqual([0, 0, 0]);
  });

  test("applies constrained rotation and scale through core commands", () => {
    const document = documentFixture();
    document.selection.mode = "object";
    document.selection.componentIds = [];

    const rotationCommand = createTransformCommand(document, [Math.PI / 2, 0, 0], {
      operation: "rotate",
      axis: 0,
      snap: false,
      snapStep: 15,
    });
    const scaleCommand = createTransformCommand(document, [2, 3, 4], {
      operation: "scale",
      axis: 2,
      snap: false,
      snapStep: 0.1,
    });

    const rotation = rotationCommand?.arguments.transform as ModelingObject["transform"];
    const scale = scaleCommand?.arguments.transform as ModelingObject["transform"];
    expect(rotationCommand?.commandId).toBe("object.setTransform");
    expect(rotation?.rotation[0]).toBeCloseTo(Math.SQRT1_2);
    expect(rotation?.rotation[3]).toBeCloseTo(Math.SQRT1_2);
    expect(scale?.scale).toEqual([1, 1, 4]);
  });

  test("returns no component transform when selection is empty", () => {
    const document = documentFixture();
    document.selection.componentIds = [];
    expect(
      createTransformCommand(document, [1, 0, 0], {
        operation: "translate",
        axis: null,
        snap: false,
        snapStep: 0.1,
      }),
    ).toBeNull();
  });
});