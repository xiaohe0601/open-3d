export function createWorkspaceDocument(
  objectCount?: number,
  gridSize?: number,
): {
  schemaVersion: 1;
  id: string;
  name: string;
  activeSceneId: string;
  scenes: { id: string; name: string; objectIds: string[] }[];
  objects: {
    id: string;
    name: string;
    transform: {
      position: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    };
    mesh: {
      id: string;
      vertices: { id: string; position: [number, number, number] }[];
      edges: { id: string; vertexIds: [string, string] }[];
      faces: { id: string; vertexIds: string[]; materialId: null }[];
    };
    visible: boolean;
    parentId: null;
  }[];
  materials: never[];
  selection: {
    mode: "object";
    objectIds: string[];
    componentIds: string[];
    activeObjectId: null;
  };
  workspace: {
    projection: "perspective";
    cameraPosition: [number, number, number];
    cameraTarget: [number, number, number];
    cameraRotation: [number, number, number, number];
    fieldOfView: number;
    orthographicScale: number;
    showGrid: boolean;
    showAxes: boolean;
  };
};