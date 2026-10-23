export const MODELING_CONTRACT_VERSION = 1 as const;

export type SchemaType = "array" | "boolean" | "integer" | "number" | "object" | "string";

export interface ValueSchema {
  type: SchemaType;
  nullable?: boolean;
  description?: string;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: ValueSchema;
  properties?: Readonly<Record<string, ValueSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface CommandPrecondition {
  code: string;
  description: string;
}

export interface ResultShape {
  type: "object";
  description: string;
  properties: Readonly<Record<string, ValueSchema>>;
  required: readonly string[];
}

export interface CommandDescriptor {
  kind: "command";
  id: string;
  title: string;
  description: string;
  parameters: ValueSchema;
  preconditions: readonly CommandPrecondition[];
  result: ResultShape;
}

export interface QueryDescriptor {
  kind: "query";
  id: string;
  title: string;
  description: string;
  parameters: ValueSchema;
  result: ResultShape;
}

export const ModelingErrorCodes = [
  "unknown-command",
  "unknown-query",
  "incompatible-contract-version",
  "invalid-arguments",
  "precondition-failed",
  "not-found",
  "operation-ineligible",
  "command-unavailable",
  "invalid-result",
  "invalid-document",
  "execution-failed",
] as const;

export type ModelingErrorCode = (typeof ModelingErrorCodes)[number];

export interface ModelingErrorDetails {
  path?: string;
  issues?: readonly { path: string; message: string }[];
  [key: string]: unknown;
}

export class ModelingContractError extends Error {
  readonly code: ModelingErrorCode;
  readonly details: ModelingErrorDetails;

  constructor(code: ModelingErrorCode, message: string, details: ModelingErrorDetails = {}) {
    super(message);
    this.name = "ModelingContractError";
    this.code = code;
    this.details = details;
  }
}

const nonEmptyString: ValueSchema = { type: "string", description: "A non-empty identifier or name." };
const finiteNumber: ValueSchema = { type: "number" };
const positiveNumber: ValueSchema = { type: "number", minimum: Number.MIN_VALUE };
const idList: ValueSchema = { type: "array", items: nonEmptyString, minItems: 1, maxItems: 1000 };
const vec3: ValueSchema = {
  type: "array",
  items: finiteNumber,
  minItems: 3,
  maxItems: 3,
  description: "Three numeric values in X, Y, Z order.",
};
const quaternion: ValueSchema = {
  type: "array",
  items: finiteNumber,
  minItems: 4,
  maxItems: 4,
  description: "Quaternion in X, Y, Z, W order.",
};
const transformSchema: ValueSchema = {
  type: "object",
  properties: {
    position: vec3,
    rotation: quaternion,
    scale: vec3,
  },
  required: ["position", "rotation", "scale"],
  additionalProperties: false,
};
const affectedResult: ResultShape = {
  type: "object",
  description: "The command result identifies affected document entities and resulting selection.",
  properties: {
    affectedEntityIds: { type: "array", items: nonEmptyString },
    selection: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["object", "vertex", "edge", "face"] },
        objectIds: { type: "array", items: nonEmptyString },
        componentIds: { type: "array", items: nonEmptyString },
        activeObjectId: { type: "string", nullable: true },
      },
      required: ["mode", "objectIds", "componentIds", "activeObjectId"],
      additionalProperties: false,
    },
  },
  required: ["affectedEntityIds", "selection"],
};
const result = (description: string, properties: Record<string, ValueSchema>, required: string[]): ResultShape => ({
  type: "object",
  description,
  properties,
  required,
});
const objectSchema = (properties: Record<string, ValueSchema>, required: string[]): ValueSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const condition = (code: string, description: string): CommandPrecondition => ({ code, description });
const selectedComponents = (mode: "vertex" | "edge" | "face", minimum = 1): CommandPrecondition =>
  condition(
    `selection.${mode}`,
    `At least ${minimum} valid ${mode} component${minimum === 1 ? "" : "s"} are selected on one editable mesh.`,
  );

export const MODELING_COMMANDS = [
  {
    kind: "command",
    id: "document.rename",
    title: "Rename project",
    description: "Set the project name without replacing the document or resetting edit history.",
    parameters: objectSchema({ name: nonEmptyString }, ["name"]),
    preconditions: [],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "scene.createPrimitive",
    title: "Create primitive",
    description: "Add a supported mesh primitive to the active scene and select it.",
    parameters: objectSchema(
      {
        primitive: { type: "string", enum: ["box", "uv-sphere", "cylinder"] },
        name: nonEmptyString,
        segments: { type: "integer", minimum: 3, maximum: 256 },
        size: { type: "number", minimum: Number.EPSILON },
      },
      ["primitive"],
    ),
    preconditions: [condition("scene.active", "The document has an active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "object.rename",
    title: "Rename object",
    description: "Set the display name of one existing scene object.",
    parameters: objectSchema({ objectId: nonEmptyString, name: nonEmptyString }, ["objectId", "name"]),
    preconditions: [condition("object.exists", "The target object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "object.duplicate",
    title: "Duplicate object",
    description: "Duplicate a selected object with fresh stable identities.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        offset: vec3,
        name: nonEmptyString,
      },
      ["objectId"],
    ),
    preconditions: [condition("object.exists", "The target object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "object.setVisibility",
    title: "Set object visibility",
    description: "Hide or show one or more objects in the active scene.",
    parameters: objectSchema({ objectIds: idList, visible: { type: "boolean" } }, ["objectIds", "visible"]),
    preconditions: [condition("objects.exist", "Every target object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "object.delete",
    title: "Delete objects",
    description: "Delete one or more objects and clear affected selection references.",
    parameters: objectSchema({ objectIds: idList }, ["objectIds"]),
    preconditions: [condition("objects.exist", "Every target object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "object.setTransform",
    title: "Set object transform",
    description: "Set an object's translation, rotation, and scale.",
    parameters: objectSchema({ objectId: nonEmptyString, transform: transformSchema }, ["objectId", "transform"]),
    preconditions: [condition("object.exists", "The target object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "selection.setObjects",
    title: "Select objects",
    description: "Replace the current object selection with the supplied objects.",
    parameters: objectSchema({ objectIds: { type: "array", items: nonEmptyString } }, ["objectIds"]),
    preconditions: [condition("objects.exist", "Every selected object exists in the active scene.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "selection.setComponents",
    title: "Select mesh components",
    description: "Replace the component selection on a single mesh.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        mode: { type: "string", enum: ["vertex", "edge", "face"] },
        componentIds: { type: "array", items: nonEmptyString },
      },
      ["objectId", "mode", "componentIds"],
    ),
    preconditions: [condition("mesh.editable", "The target object has an editable polygon mesh.")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "selection.setMode",
    title: "Set selection mode",
    description: "Change between object, vertex, edge, and face selection modes using the documented conversion rule.",
    parameters: objectSchema(
      {
        mode: { type: "string", enum: ["object", "vertex", "edge", "face"] },
        conversion: {
          type: "string",
          enum: ["convert", "clear"],
          description:
            "Convert preserves equivalent components, maps vertices to incident edges/faces, edges to endpoints/incident faces, and faces to their vertices/boundary edges. Object-to-component selects all components on the active mesh; component-to-object selects its owner. Clear empties the selection while retaining the active mesh owner in component modes.",
        },
      },
      ["mode", "conversion"],
    ),
    preconditions: [],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.transformComponents",
    title: "Transform selected components",
    description: "Apply a translation, rotation, or scale delta to selected mesh components.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        mode: { type: "string", enum: ["vertex", "edge", "face"] },
        operation: { type: "string", enum: ["translate", "rotate", "scale"] },
        value: vec3,
        pivot: vec3,
      },
      ["objectId", "mode", "operation", "value"],
    ),
    preconditions: [
      condition("mesh.editable", "The target object has an editable polygon mesh."),
      condition(
        "selection.components",
        "At least one valid component of the requested mode is selected on the target mesh.",
      ),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.extrude",
    title: "Extrude components",
    description:
      "Extrude a connected face region, one vertex, or an eligible open boundary edge chain by distance along a normalized direction.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        mode: { type: "string", enum: ["vertex", "edge", "face"] },
        componentIds: idList,
        distance: finiteNumber,
        direction: vec3,
      },
      ["objectId", "mode", "componentIds", "distance", "direction"],
    ),
    preconditions: [
      condition("mesh.editable", "The target object has an editable polygon mesh."),
      condition(
        "selection.extrudable",
        "The selected connected region satisfies the accepted extrusion topology contract.",
      ),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.insetFaces",
    title: "Inset faces",
    description: "Inset an eligible connected planar face region with a simple boundary by an offset distance.",
    parameters: objectSchema({ objectId: nonEmptyString, faceIds: idList, offset: positiveNumber }, [
      "objectId",
      "faceIds",
      "offset",
    ]),
    preconditions: [
      condition("selection.faces", "One or more faces are selected on the target mesh."),
      condition(
        "selection.insetEligible",
        "The face region is connected, planar, simple, and does not collapse at this offset.",
      ),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.mergeVertices",
    title: "Merge vertices",
    description: "Merge selected vertices at their center or at the last-selected vertex.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        vertexIds: { ...idList, minItems: 2 },
        target: { type: "string", enum: ["center", "last-selected"] },
      },
      ["objectId", "vertexIds", "target"],
    ),
    preconditions: [selectedComponents("vertex", 2)],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.dissolveEdges",
    title: "Dissolve edges",
    description:
      "Dissolve selected interior manifold edges into simple, single-material polygon regions while preserving their outer boundaries.",
    parameters: objectSchema({ objectId: nonEmptyString, edgeIds: idList, preserveBoundary: { type: "boolean" } }, [
      "objectId",
      "edgeIds",
    ]),
    preconditions: [
      selectedComponents("edge"),
      condition(
        "selection.dissolveEligible",
        "Selected edges are interior manifold edges with a valid merged surface.",
      ),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.dissolveFaces",
    title: "Dissolve faces",
    description:
      "Merge each eligible connected selected face region of two or more faces into one simple, single-material polygon.",
    parameters: objectSchema({ objectId: nonEmptyString, faceIds: idList }, ["objectId", "faceIds"]),
    preconditions: [
      selectedComponents("face"),
      condition("selection.dissolveEligible", "The selected faces can be dissolved without invalid topology."),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.bevelEdges",
    title: "Bevel edges",
    description: "Bevel eligible selected manifold edges using a width and segment count.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        edgeIds: idList,
        width: positiveNumber,
        segments: { type: "integer", minimum: 1, maximum: 32 },
      },
      ["objectId", "edgeIds", "width", "segments"],
    ),
    preconditions: [
      selectedComponents("edge"),
      condition("selection.bevelEligible", "Selected edges and width preserve valid adjacent faces."),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.loopCut",
    title: "Cut quad loop",
    description: "Insert evenly spaced cuts along an eligible continuous quad loop.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        edgeId: nonEmptyString,
        cuts: { type: "integer", minimum: 1, maximum: 64 },
        position: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      },
      ["objectId", "edgeId", "cuts", "position"],
    ),
    preconditions: [
      condition("mesh.quadLoop", "The traversed loop is closed, unbranched, and crosses only supported quad faces."),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.recalculateNormals",
    title: "Recalculate normals",
    description: "Recalculate consistent normals for the selected eligible mesh component.",
    parameters: objectSchema({ objectId: nonEmptyString, scope: { type: "string", enum: ["connected-component"] } }, [
      "objectId",
      "scope",
    ]),
    preconditions: [
      condition(
        "mesh.orientableManifold",
        "The selected component is orientable, manifold, and contains no degenerate faces.",
      ),
    ],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "mesh.flipNormals",
    title: "Flip normals",
    description: "Reverse winding for selected valid faces.",
    parameters: objectSchema({ objectId: nonEmptyString, faceIds: idList }, ["objectId", "faceIds"]),
    preconditions: [selectedComponents("face")],
    result: affectedResult,
  },
  {
    kind: "command",
    id: "workspace.setView",
    title: "Set workspace view",
    description: "Update camera, projection, standard orientation, grid, or axes settings.",
    parameters: objectSchema(
      {
        projection: { type: "string", enum: ["perspective", "orthographic"] },
        cameraPosition: vec3,
        cameraTarget: vec3,
        cameraRotation: quaternion,
        fieldOfView: { type: "number", minimum: 1, maximum: 179 },
        orthographicScale: positiveNumber,
        showGrid: { type: "boolean" },
        showAxes: { type: "boolean" },
      },
      [],
    ),
    preconditions: [],
    result: result(
      "The workspace view settings that changed.",
      {
        changedSettings: { type: "array", items: nonEmptyString },
      },
      ["changedSettings"],
    ),
  },
] as const satisfies readonly CommandDescriptor[];

export const MODELING_QUERIES = [
  {
    kind: "query",
    id: "scene.getHierarchy",
    title: "Get scene hierarchy",
    description: "Return a bounded, serializable hierarchy of scenes and objects.",
    parameters: objectSchema(
      {
        sceneId: nonEmptyString,
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "string" },
      },
      [],
    ),
    result: result(
      "A bounded scene hierarchy page.",
      {
        sceneId: nonEmptyString,
        items: {
          type: "array",
          items: objectSchema(
            {
              id: nonEmptyString,
              name: nonEmptyString,
              parentId: { type: "string", nullable: true },
              visible: { type: "boolean" },
            },
            ["id", "name", "parentId", "visible"],
          ),
        },
        nextCursor: { type: "string", nullable: true },
      },
      ["sceneId", "items", "nextCursor"],
    ),
  },
  {
    kind: "query",
    id: "object.getTransform",
    title: "Get object transform",
    description: "Return the transform of one object.",
    parameters: objectSchema({ objectId: nonEmptyString }, ["objectId"]),
    result: result("An object's stable ID and transform.", { objectId: nonEmptyString, transform: transformSchema }, [
      "objectId",
      "transform",
    ]),
  },
  {
    kind: "query",
    id: "mesh.getSummary",
    title: "Get mesh summary",
    description: "Return bounded mesh counts and optional component details.",
    parameters: objectSchema(
      {
        objectId: nonEmptyString,
        includeComponents: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        cursor: { type: "string" },
      },
      ["objectId"],
    ),
    result: result(
      "A serializable mesh summary without renderer objects.",
      {
        objectId: nonEmptyString,
        vertexCount: { type: "integer", minimum: 0 },
        edgeCount: { type: "integer", minimum: 0 },
        faceCount: { type: "integer", minimum: 0 },
        components: {
          type: "array",
          items: objectSchema(
            {
              id: nonEmptyString,
              kind: { type: "string", enum: ["vertex", "edge", "face"] },
            },
            ["id", "kind"],
          ),
        },
        nextCursor: { type: "string", nullable: true },
      },
      ["objectId", "vertexCount", "edgeCount", "faceCount", "components", "nextCursor"],
    ),
  },
  {
    kind: "query",
    id: "selection.get",
    title: "Get selection",
    description: "Return the current selection in stable document IDs.",
    parameters: objectSchema({}, []),
    result: result(
      "Current object and component selection.",
      {
        mode: { type: "string", enum: ["object", "vertex", "edge", "face"] },
        objectIds: { type: "array", items: nonEmptyString },
        componentIds: { type: "array", items: nonEmptyString },
        activeObjectId: { type: "string", nullable: true },
      },
      ["mode", "objectIds", "componentIds", "activeObjectId"],
    ),
  },
  {
    kind: "query",
    id: "editor.getMode",
    title: "Get editor mode",
    description: "Return the active editor and component selection mode.",
    parameters: objectSchema({}, []),
    result: result(
      "Current editor mode.",
      {
        editor: { type: "string", enum: ["object", "mesh"] },
        selectionMode: { type: "string", enum: ["object", "vertex", "edge", "face"] },
      },
      ["editor", "selectionMode"],
    ),
  },
  {
    kind: "query",
    id: "operation.getEligibility",
    title: "Get operation eligibility",
    description: "Check whether a catalog command is currently eligible and explain blockers.",
    parameters: objectSchema(
      {
        commandId: nonEmptyString,
        arguments: { type: "object", additionalProperties: true },
      },
      ["commandId"],
    ),
    result: result(
      "Operation eligibility and any structured blockers.",
      {
        eligible: { type: "boolean" },
        blockers: {
          type: "array",
          items: objectSchema(
            {
              code: nonEmptyString,
              message: nonEmptyString,
            },
            ["code", "message"],
          ),
        },
      },
      ["eligible", "blockers"],
    ),
  },
] as const satisfies readonly QueryDescriptor[];

export interface ModelingOperationCatalog {
  contractVersion: typeof MODELING_CONTRACT_VERSION;
  commands: readonly CommandDescriptor[];
  queries: readonly QueryDescriptor[];
}

export function getModelingOperationCatalog(): ModelingOperationCatalog {
  return {
    contractVersion: MODELING_CONTRACT_VERSION,
    commands: MODELING_COMMANDS,
    queries: MODELING_QUERIES,
  };
}

export function getCommandDescriptor(commandId: string): CommandDescriptor {
  const descriptor = MODELING_COMMANDS.find((command) => command.id === commandId);
  if (!descriptor) {
    throw new ModelingContractError("unknown-command", `Unknown modeling command "${commandId}".`, {
      commandId,
    });
  }
  return descriptor;
}

export function getQueryDescriptor(queryId: string): QueryDescriptor {
  const descriptor = MODELING_QUERIES.find((query) => query.id === queryId);
  if (!descriptor) {
    throw new ModelingContractError("unknown-query", `Unknown modeling query "${queryId}".`, {
      queryId,
    });
  }
  return descriptor;
}

export function validateQueryArguments(
  queryId: string,
  argumentsValue: unknown,
  contractVersion: number = MODELING_CONTRACT_VERSION,
): asserts argumentsValue is Record<string, unknown> {
  if (contractVersion !== MODELING_CONTRACT_VERSION) {
    throw new ModelingContractError(
      "incompatible-contract-version",
      `Contract version ${contractVersion} is not supported; expected ${MODELING_CONTRACT_VERSION}.`,
      { receivedVersion: contractVersion, supportedVersion: MODELING_CONTRACT_VERSION },
    );
  }
  const descriptor = getQueryDescriptor(queryId);
  const issues: SchemaIssue[] = [];
  validateValue(argumentsValue, descriptor.parameters, "$.arguments", issues);
  if (issues.length > 0) {
    throw new ModelingContractError("invalid-arguments", "Query arguments do not match the catalog schema.", {
      queryId,
      issues,
    });
  }
}

interface SchemaIssue {
  path: string;
  message: string;
}

function schemaTypeMatches(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "string":
      return typeof value === "string";
  }
}

function validateValue(value: unknown, schema: ValueSchema, path: string, issues: SchemaIssue[]): void {
  if (schema.nullable && value === null) return;
  if (!schemaTypeMatches(value, schema.type)) {
    issues.push({ path, message: `Expected ${schema.type}.` });
    return;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    issues.push({ path, message: `Expected one of: ${schema.enum.join(", ")}.` });
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && (value as number) < schema.minimum) {
      issues.push({ path, message: `Expected a value greater than or equal to ${schema.minimum}.` });
    }
    if (schema.maximum !== undefined && (value as number) > schema.maximum) {
      issues.push({ path, message: `Expected a value less than or equal to ${schema.maximum}.` });
    }
    if (schema.exclusiveMinimum !== undefined && (value as number) <= schema.exclusiveMinimum) {
      issues.push({ path, message: `Expected a value greater than ${schema.exclusiveMinimum}.` });
    }
    if (schema.exclusiveMaximum !== undefined && (value as number) >= schema.exclusiveMaximum) {
      issues.push({ path, message: `Expected a value less than ${schema.exclusiveMaximum}.` });
    }
  }
  if (schema.type === "array") {
    const values = value as unknown[];
    if (schema.minItems !== undefined && values.length < schema.minItems) {
      issues.push({ path, message: `Expected at least ${schema.minItems} items.` });
    }
    if (schema.maxItems !== undefined && values.length > schema.maxItems) {
      issues.push({ path, message: `Expected at most ${schema.maxItems} items.` });
    }
    if (schema.items) values.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, issues));
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) issues.push({ path: `${path}.${key}`, message: "Required property is missing." });
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        validateValue(item, propertySchema, `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: "Unknown property." });
      }
    }
  }
}

export function validateCommandResult(commandId: string, resultValue: unknown): void {
  const descriptor = getCommandDescriptor(commandId);
  const issues: SchemaIssue[] = [];
  validateValue(
    resultValue,
    {
      type: descriptor.result.type,
      properties: descriptor.result.properties,
      required: descriptor.result.required,
      additionalProperties: false,
    },
    "$.result",
    issues,
  );
  if (issues.length > 0) {
    throw new ModelingContractError("invalid-result", "Command result does not match the catalog schema.", {
      commandId,
      issues,
    });
  }
}

export function validateCommandArguments(
  commandId: string,
  argumentsValue: unknown,
  contractVersion: number = MODELING_CONTRACT_VERSION,
): asserts argumentsValue is Record<string, unknown> {
  if (contractVersion !== MODELING_CONTRACT_VERSION) {
    throw new ModelingContractError(
      "incompatible-contract-version",
      `Contract version ${contractVersion} is not supported; expected ${MODELING_CONTRACT_VERSION}.`,
      { receivedVersion: contractVersion, supportedVersion: MODELING_CONTRACT_VERSION },
    );
  }
  const descriptor = getCommandDescriptor(commandId);
  const issues: SchemaIssue[] = [];
  validateValue(argumentsValue, descriptor.parameters, "$.arguments", issues);
  if (issues.length > 0) {
    throw new ModelingContractError("invalid-arguments", "Command arguments do not match the catalog schema.", {
      commandId,
      issues,
    });
  }
}