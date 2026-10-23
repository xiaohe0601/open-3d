export const DOCUMENT_SCHEMA_VERSION = 1 as const;

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Quaternion;
  scale: Vec3;
}

export interface MeshVertex {
  id: string;
  position: Vec3;
}

export interface MeshEdge {
  id: string;
  vertexIds: [string, string];
}

export interface MeshFace {
  id: string;
  vertexIds: string[];
  materialId: string | null;
}

export interface PolygonMesh {
  id: string;
  vertices: MeshVertex[];
  edges: MeshEdge[];
  faces: MeshFace[];
}

export interface ModelingObject {
  id: string;
  name: string;
  transform: Transform;
  mesh: PolygonMesh | null;
  visible: boolean;
  parentId: string | null;
}

export interface ModelingScene {
  id: string;
  name: string;
  objectIds: string[];
}

export interface ModelingMaterial {
  id: string;
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
}

export type SelectionMode = "object" | "vertex" | "edge" | "face";

export interface ModelingSelection {
  mode: SelectionMode;
  objectIds: string[];
  componentIds: string[];
  activeObjectId: string | null;
}

export interface WorkspaceViewSettings {
  projection: "perspective" | "orthographic";
  cameraPosition: Vec3;
  cameraTarget: Vec3;
  cameraRotation: Quaternion;
  fieldOfView: number;
  orthographicScale: number;
  showGrid: boolean;
  showAxes: boolean;
}

export interface ModelingDocument {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: string;
  name: string;
  activeSceneId: string;
  scenes: ModelingScene[];
  objects: ModelingObject[];
  materials: ModelingMaterial[];
  selection: ModelingSelection;
  workspace: WorkspaceViewSettings;
}

export interface DocumentValidationIssue {
  path: string;
  message: string;
}

export class DocumentValidationError extends Error {
  readonly issues: DocumentValidationIssue[];

  constructor(issues: DocumentValidationIssue[]) {
    super(`Invalid modeling document: ${issues.map(({ path }) => path).join(", ")}`);
    this.name = "DocumentValidationError";
    this.issues = issues;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validateTuple(
  value: unknown,
  length: number,
  path: string,
  issues: DocumentValidationIssue[],
): value is number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => !isFiniteNumber(item))) {
    issues.push({ path, message: `Expected ${length} finite numbers.` });
    return false;
  }
  return true;
}

function validateStrings(value: unknown, path: string, issues: DocumentValidationIssue[]): value is string[] {
  if (!Array.isArray(value) || value.some((item) => !isString(item))) {
    issues.push({ path, message: "Expected an array of non-empty strings." });
    return false;
  }
  return true;
}

function validateTransform(value: unknown, path: string, issues: DocumentValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected a transform object." });
    return;
  }
  validateTuple(value.position, 3, `${path}.position`, issues);
  validateTuple(value.rotation, 4, `${path}.rotation`, issues);
  validateTuple(value.scale, 3, `${path}.scale`, issues);
}

function validateMesh(
  value: unknown,
  path: string,
  issues: DocumentValidationIssue[],
  ids: Set<string>,
  materialIds: Set<string>,
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected a polygon mesh object." });
    return;
  }
  if (!isString(value.id)) issues.push({ path: `${path}.id`, message: "Expected a non-empty ID." });
  else if (ids.has(value.id)) issues.push({ path: `${path}.id`, message: `Duplicate ID "${value.id}".` });
  else ids.add(value.id);

  const vertexIds = new Set<string>();
  if (!Array.isArray(value.vertices)) {
    issues.push({ path: `${path}.vertices`, message: "Expected an array." });
  } else {
    value.vertices.forEach((vertex, index) => {
      const itemPath = `${path}.vertices[${index}]`;
      if (!isRecord(vertex)) {
        issues.push({ path: itemPath, message: "Expected a vertex object." });
        return;
      }
      if (!isString(vertex.id)) issues.push({ path: `${itemPath}.id`, message: "Expected a non-empty ID." });
      else {
        if (ids.has(vertex.id)) issues.push({ path: `${itemPath}.id`, message: `Duplicate ID "${vertex.id}".` });
        else ids.add(vertex.id);
        vertexIds.add(vertex.id);
      }
      validateTuple(vertex.position, 3, `${itemPath}.position`, issues);
    });
  }

  if (!Array.isArray(value.edges)) {
    issues.push({ path: `${path}.edges`, message: "Expected an array." });
  } else {
    value.edges.forEach((edge, index) => {
      const itemPath = `${path}.edges[${index}]`;
      if (!isRecord(edge)) {
        issues.push({ path: itemPath, message: "Expected an edge object." });
        return;
      }
      if (!isString(edge.id)) issues.push({ path: `${itemPath}.id`, message: "Expected a non-empty ID." });
      else {
        if (ids.has(edge.id)) issues.push({ path: `${itemPath}.id`, message: `Duplicate ID "${edge.id}".` });
        else ids.add(edge.id);
      }
      if (
        !Array.isArray(edge.vertexIds) ||
        edge.vertexIds.length !== 2 ||
        edge.vertexIds.some((id) => !isString(id) || !vertexIds.has(id)) ||
        edge.vertexIds[0] === edge.vertexIds[1]
      ) {
        issues.push({ path: `${itemPath}.vertexIds`, message: "Expected two distinct vertex IDs in this mesh." });
      }
    });
  }

  if (!Array.isArray(value.faces)) {
    issues.push({ path: `${path}.faces`, message: "Expected an array." });
  } else {
    value.faces.forEach((face, index) => {
      const itemPath = `${path}.faces[${index}]`;
      if (!isRecord(face)) {
        issues.push({ path: itemPath, message: "Expected a face object." });
        return;
      }
      if (!isString(face.id)) issues.push({ path: `${itemPath}.id`, message: "Expected a non-empty ID." });
      else if (ids.has(face.id)) issues.push({ path: `${itemPath}.id`, message: `Duplicate ID "${face.id}".` });
      else ids.add(face.id);
      if (
        !Array.isArray(face.vertexIds) ||
        face.vertexIds.length < 3 ||
        face.vertexIds.some((id) => !isString(id) || !vertexIds.has(id)) ||
        new Set(face.vertexIds).size !== face.vertexIds.length
      ) {
        issues.push({
          path: `${itemPath}.vertexIds`,
          message: "Expected three or more distinct vertex IDs in this mesh.",
        });
      }
      if (face.materialId !== null && (!isString(face.materialId) || !materialIds.has(face.materialId))) {
        issues.push({ path: `${itemPath}.materialId`, message: "Expected null or an existing material ID." });
      }
    });
  }
}

function validateDocument(value: unknown): DocumentValidationIssue[] {
  const issues: DocumentValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: "$", message: "Expected a document object." }];
  if (value.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    issues.push({ path: "$.schemaVersion", message: `Expected schema version ${DOCUMENT_SCHEMA_VERSION}.` });
  }
  for (const key of ["id", "name", "activeSceneId"]) {
    if (!isString(value[key])) issues.push({ path: `$.${key}`, message: "Expected a non-empty string." });
  }

  const ids = new Set<string>();
  const addId = (id: unknown, path: string) => {
    if (!isString(id)) issues.push({ path, message: "Expected a non-empty ID." });
    else if (ids.has(id)) issues.push({ path, message: `Duplicate ID "${id}".` });
    else ids.add(id);
  };

  if (!Array.isArray(value.materials)) {
    issues.push({ path: "$.materials", message: "Expected an array." });
  } else {
    for (const [index, material] of value.materials.entries()) {
      const path = `$.materials[${index}]`;
      if (!isRecord(material)) {
        issues.push({ path, message: "Expected a material object." });
        continue;
      }
      addId(material.id, `${path}.id`);
      if (!isString(material.name)) issues.push({ path: `${path}.name`, message: "Expected a non-empty string." });
      validateTuple(material.baseColor, 4, `${path}.baseColor`, issues);
      if (isFiniteNumber(material.metallic) && (material.metallic < 0 || material.metallic > 1)) {
        issues.push({ path: `${path}.metallic`, message: "Expected a value from 0 to 1." });
      } else if (!isFiniteNumber(material.metallic)) {
        issues.push({ path: `${path}.metallic`, message: "Expected a finite number." });
      }
      if (isFiniteNumber(material.roughness) && (material.roughness < 0 || material.roughness > 1)) {
        issues.push({ path: `${path}.roughness`, message: "Expected a value from 0 to 1." });
      } else if (!isFiniteNumber(material.roughness)) {
        issues.push({ path: `${path}.roughness`, message: "Expected a finite number." });
      }
    }
  }
  const materialIds = new Set(
    Array.isArray(value.materials)
      ? value.materials.flatMap((material) => (isRecord(material) && isString(material.id) ? [material.id] : []))
      : [],
  );

  const sceneIds = new Set<string>();
  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    issues.push({ path: "$.scenes", message: "Expected at least one scene." });
  } else {
    value.scenes.forEach((scene, index) => {
      const path = `$.scenes[${index}]`;
      if (!isRecord(scene)) {
        issues.push({ path, message: "Expected a scene object." });
        return;
      }
      addId(scene.id, `${path}.id`);
      if (isString(scene.id)) sceneIds.add(scene.id);
      if (!isString(scene.name)) issues.push({ path: `${path}.name`, message: "Expected a non-empty string." });
      if (!validateStrings(scene.objectIds, `${path}.objectIds`, issues)) return;
      if (new Set(scene.objectIds).size !== scene.objectIds.length) {
        issues.push({ path: `${path}.objectIds`, message: "Object IDs must be unique within a scene." });
      }
    });
  }

  const objectIds = new Set<string>();
  if (!Array.isArray(value.objects)) {
    issues.push({ path: "$.objects", message: "Expected an array." });
  } else {
    value.objects.forEach((object, index) => {
      const path = `$.objects[${index}]`;
      if (!isRecord(object)) {
        issues.push({ path, message: "Expected an object." });
        return;
      }
      addId(object.id, `${path}.id`);
      if (isString(object.id)) objectIds.add(object.id);
      if (!isString(object.name)) issues.push({ path: `${path}.name`, message: "Expected a non-empty string." });
      validateTransform(object.transform, `${path}.transform`, issues);
      if (typeof object.visible !== "boolean") issues.push({ path: `${path}.visible`, message: "Expected a boolean." });
      if (object.parentId !== null && !isString(object.parentId)) {
        issues.push({ path: `${path}.parentId`, message: "Expected null or an object ID." });
      }
      if (object.mesh !== null) validateMesh(object.mesh, `${path}.mesh`, issues, ids, materialIds);
    });
  }

  if (Array.isArray(value.scenes)) {
    value.scenes.forEach((scene, index) => {
      if (!isRecord(scene) || !Array.isArray(scene.objectIds)) return;
      for (const objectId of scene.objectIds) {
        if (!objectIds.has(objectId)) {
          issues.push({ path: `$.scenes[${index}].objectIds`, message: `Unknown object ID "${objectId}".` });
        }
      }
    });
  }
  if (Array.isArray(value.objects)) {
    value.objects.forEach((object, index) => {
      if (
        isRecord(object) &&
        object.parentId !== null &&
        isString(object.parentId) &&
        !objectIds.has(object.parentId)
      ) {
        issues.push({ path: `$.objects[${index}].parentId`, message: `Unknown parent object "${object.parentId}".` });
      }
    });
  }
  if (isString(value.activeSceneId) && !sceneIds.has(value.activeSceneId)) {
    issues.push({ path: "$.activeSceneId", message: "Expected an existing scene ID." });
  }

  const selection = value.selection;
  if (!isRecord(selection)) {
    issues.push({ path: "$.selection", message: "Expected a selection object." });
  } else {
    const modes: SelectionMode[] = ["object", "vertex", "edge", "face"];
    if (!modes.includes(selection.mode as SelectionMode)) {
      issues.push({ path: "$.selection.mode", message: "Expected object, vertex, edge, or face." });
    }
    const hasValidObjectIds = validateStrings(selection.objectIds, "$.selection.objectIds", issues);
    const selectedObjectIds = hasValidObjectIds ? (selection.objectIds as string[]) : [];
    if (hasValidObjectIds && new Set(selectedObjectIds).size !== selectedObjectIds.length) {
      issues.push({ path: "$.selection.objectIds", message: "Selected object IDs must be unique." });
    }
    if (hasValidObjectIds && selectedObjectIds.some((id) => !objectIds.has(id))) {
      issues.push({ path: "$.selection.objectIds", message: "Selection references an unknown object." });
    }
    if (validateStrings(selection.componentIds, "$.selection.componentIds", issues)) {
      if (new Set(selection.componentIds).size !== selection.componentIds.length) {
        issues.push({ path: "$.selection.componentIds", message: "Selected component IDs must be unique." });
      }
      if (selection.mode === "object" && selection.componentIds.length > 0) {
        issues.push({ path: "$.selection.componentIds", message: "Object selection cannot contain component IDs." });
      } else if (selection.mode !== "object") {
        if (!hasValidObjectIds || selectedObjectIds.length !== 1) {
          issues.push({
            path: "$.selection.objectIds",
            message: "Component selection must target exactly one object.",
          });
        } else if (selection.activeObjectId !== selectedObjectIds[0]) {
          issues.push({
            path: "$.selection.activeObjectId",
            message: "The active object must own the component selection.",
          });
        } else {
          const target = Array.isArray(value.objects)
            ? value.objects.find((object) => isRecord(object) && object.id === selectedObjectIds[0])
            : undefined;
          const mesh = isRecord(target) && isRecord(target.mesh) ? target.mesh : null;
          const collection =
            mesh && selection.mode === "vertex"
              ? mesh.vertices
              : mesh && selection.mode === "edge"
                ? mesh.edges
                : mesh && selection.mode === "face"
                  ? mesh.faces
                  : null;
          const availableIds = new Set(
            Array.isArray(collection)
              ? collection.flatMap((component) => (isRecord(component) && isString(component.id) ? [component.id] : []))
              : [],
          );
          if (!mesh || selection.componentIds.some((id) => !availableIds.has(id))) {
            issues.push({
              path: "$.selection.componentIds",
              message: "Selection references an unknown component for the active mode.",
            });
          }
        }
      }
    }
    if (selection.activeObjectId !== null && !isString(selection.activeObjectId)) {
      issues.push({ path: "$.selection.activeObjectId", message: "Expected null or an object ID." });
    } else if (isString(selection.activeObjectId) && !objectIds.has(selection.activeObjectId)) {
      issues.push({ path: "$.selection.activeObjectId", message: "Expected an existing object ID." });
    }
    if (
      selection.mode === "object" &&
      isString(selection.activeObjectId) &&
      hasValidObjectIds &&
      !selectedObjectIds.includes(selection.activeObjectId)
    ) {
      issues.push({
        path: "$.selection.activeObjectId",
        message: "The active object must be included in the object selection.",
      });
    }
  }

  const workspace = value.workspace;
  if (!isRecord(workspace)) {
    issues.push({ path: "$.workspace", message: "Expected workspace view settings." });
  } else {
    if (workspace.projection !== "perspective" && workspace.projection !== "orthographic") {
      issues.push({ path: "$.workspace.projection", message: "Expected perspective or orthographic." });
    }
    validateTuple(workspace.cameraPosition, 3, "$.workspace.cameraPosition", issues);
    validateTuple(workspace.cameraTarget, 3, "$.workspace.cameraTarget", issues);
    validateTuple(workspace.cameraRotation, 4, "$.workspace.cameraRotation", issues);
    for (const key of ["fieldOfView", "orthographicScale"]) {
      if (!isFiniteNumber(workspace[key]) || workspace[key] <= 0) {
        issues.push({ path: `$.workspace.${key}`, message: "Expected a positive finite number." });
      }
    }
    for (const key of ["showGrid", "showAxes"]) {
      if (typeof workspace[key] !== "boolean")
        issues.push({ path: `$.workspace.${key}`, message: "Expected a boolean." });
    }
  }
  return issues;
}

function canonicalize(document: ModelingDocument): ModelingDocument {
  return {
    schemaVersion: document.schemaVersion,
    id: document.id,
    name: document.name,
    activeSceneId: document.activeSceneId,
    scenes: document.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      objectIds: [...scene.objectIds],
    })),
    objects: document.objects.map((object) => ({
      id: object.id,
      name: object.name,
      transform: {
        position: [...object.transform.position],
        rotation: [...object.transform.rotation],
        scale: [...object.transform.scale],
      },
      mesh:
        object.mesh === null
          ? null
          : {
              id: object.mesh.id,
              vertices: object.mesh.vertices.map((vertex) => ({
                id: vertex.id,
                position: [...vertex.position],
              })),
              edges: object.mesh.edges.map((edge) => ({
                id: edge.id,
                vertexIds: [...edge.vertexIds],
              })),
              faces: object.mesh.faces.map((face) => ({
                id: face.id,
                vertexIds: [...face.vertexIds],
                materialId: face.materialId,
              })),
            },
      visible: object.visible,
      parentId: object.parentId,
    })),
    materials: document.materials.map((material) => ({
      id: material.id,
      name: material.name,
      baseColor: [...material.baseColor],
      metallic: material.metallic,
      roughness: material.roughness,
    })),
    selection: {
      mode: document.selection.mode,
      objectIds: [...document.selection.objectIds],
      componentIds: [...document.selection.componentIds],
      activeObjectId: document.selection.activeObjectId,
    },
    workspace: {
      projection: document.workspace.projection,
      cameraPosition: [...document.workspace.cameraPosition],
      cameraTarget: [...document.workspace.cameraTarget],
      cameraRotation: [...document.workspace.cameraRotation],
      fieldOfView: document.workspace.fieldOfView,
      orthographicScale: document.workspace.orthographicScale,
      showGrid: document.workspace.showGrid,
      showAxes: document.workspace.showAxes,
    },
  };
}

export function validateModelingDocument(value: unknown): asserts value is ModelingDocument {
  const issues = validateDocument(value);
  if (issues.length > 0) throw new DocumentValidationError(issues);
}

export function serializeModelingDocument(document: ModelingDocument): string {
  validateModelingDocument(document);
  return JSON.stringify(canonicalize(document));
}

export function deserializeModelingDocument(serialized: string): ModelingDocument {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new DocumentValidationError([{ path: "$", message: "Expected valid JSON." }]);
  }
  validateModelingDocument(value);
  return canonicalize(value);
}