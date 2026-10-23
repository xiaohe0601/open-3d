import { Accessor, Document, Primitive, WebIO } from "@gltf-transform/core";
import {
  deserializeModelingDocument,
  serializeModelingDocument,
  type ModelingDocument,
  type ModelingObject,
} from "@open-3d/model-core";

export type GltfFormat = "glb" | "gltf";

export interface GltfImportResult {
  document: ModelingDocument;
  omittedContent: string[];
}

export interface GltfExportResult {
  data: Uint8Array | string;
  mimeType: string;
  extension: GltfFormat;
  omittedContent: string[];
}

export interface GltfResourceFile {
  name: string;
  data: Uint8Array;
}

interface ImportedVertex {
  id: string;
  position: [number, number, number];
}

function createId(prefix: string, index: number): string {
  return `${prefix}-${index + 1}`;
}

function reportUnsupportedContent(root: ReturnType<Document["getRoot"]>): string[] {
  const report: string[] = [];
  if (root.listAnimations().length) report.push(`${root.listAnimations().length} animation(s) were omitted.`);
  if (root.listCameras().length) report.push(`${root.listCameras().length} camera(s) were omitted.`);
  if (root.listTextures().length) report.push(`${root.listTextures().length} texture(s) were omitted.`);
  const extensions = root.listExtensionsUsed().map((extension) => extension.extensionName);
  if (extensions.length) report.push(`glTF extensions were not preserved: ${extensions.join(", ")}.`);
  return report;
}

function stripUnsupportedGltfData(json: Record<string, unknown>): string[] {
  const omitted: string[] = [];
  for (const [key, label] of [
    ["animations", "animation(s)"],
    ["cameras", "camera(s)"],
    ["images", "image/texture data"],
    ["textures", "texture(s)"],
    ["skins", "skinning data"],
  ] as const) {
    const values = json[key];
    const count = Array.isArray(values) ? values.length : 0;
    if (count) omitted.push(`${count} ${label} were omitted.`);
    delete json[key];
  }
  const extensions = Array.isArray(json.extensionsUsed)
    ? json.extensionsUsed.filter((extension): extension is string => typeof extension === "string")
    : [];
  if (extensions.length) omitted.push(`glTF extensions were not preserved: ${extensions.join(", ")}.`);
  const scenes = json.scenes;
  if (Array.isArray(scenes) && scenes.length > 1) {
    omitted.push(`${scenes.length - 1} non-default scene(s) were omitted.`);
  }
  delete json.extensionsUsed;
  delete json.extensionsRequired;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    delete record.extensions;
    delete record.extras;
    delete record.camera;
    delete record.skin;
    delete record.targets;
    delete record.morphWeights;
    delete record.weights;
    delete record.baseColorTexture;
    delete record.metallicRoughnessTexture;
    delete record.normalTexture;
    delete record.occlusionTexture;
    delete record.emissiveTexture;
    for (const child of Object.values(record)) visit(child);
  };
  visit(json);
  return omitted;
}

function triangulate(mode: number, indices: number[]): number[][] {
  if (mode === Primitive.Mode.TRIANGLES) {
    const triangles: number[][] = [];
    for (let index = 0; index + 2 < indices.length; index += 3) {
      triangles.push([indices[index], indices[index + 1], indices[index + 2]]);
    }
    return triangles;
  }
  if (mode === Primitive.Mode.TRIANGLE_STRIP) {
    const triangles: number[][] = [];
    for (let index = 0; index + 2 < indices.length; index += 1) {
      triangles.push(
        index % 2
          ? [indices[index + 1], indices[index], indices[index + 2]]
          : [indices[index], indices[index + 1], indices[index + 2]],
      );
    }
    return triangles;
  }
  if (mode === Primitive.Mode.TRIANGLE_FAN) {
    return indices.slice(1, -1).map((value, index) => [indices[0], value, indices[index + 2]]);
  }
  return [];
}

function indicesForPrimitive(primitive: Primitive): number[] {
  const indices = primitive.getIndices()?.getArray();
  if (indices) return Array.from(indices);
  const positions = primitive.getAttribute("POSITION");
  return positions ? Array.from({ length: positions.getCount() }, (_, index) => index) : [];
}

function appendPrimitive(
  primitive: Primitive,
  vertices: ImportedVertex[],
  faces: { id: string; vertexIds: string[]; materialId: string | null }[],
  materialId: string | null,
  objectIndex: number,
  primitiveIndex: number,
  omittedContent: string[],
): void {
  const position = primitive.getAttribute("POSITION");
  if (!position) {
    omittedContent.push(`Mesh primitive ${primitiveIndex + 1} has no POSITION attribute and was omitted.`);
    return;
  }
  const mode = primitive.getMode();
  const indices = indicesForPrimitive(primitive);
  const triangles = triangulate(mode, indices);
  if (!triangles.length) {
    omittedContent.push(`Mesh primitive ${primitiveIndex + 1} uses unsupported mode ${mode} and was omitted.`);
    return;
  }

  const vertexOffset = vertices.length;
  for (let index = 0; index < position.getCount(); index += 1) {
    vertices.push({
      id: createId(`gltf-v${objectIndex + 1}-p${primitiveIndex + 1}`, index),
      position: position.getElement(index, [0, 0, 0]),
    });
  }
  for (const [triangleIndex, triangle] of triangles.entries()) {
    faces.push({
      id: createId(`gltf-f${objectIndex + 1}-p${primitiveIndex + 1}`, triangleIndex),
      vertexIds: triangle.map((index) => vertices[vertexOffset + index]?.id).filter((id): id is string => !!id),
      materialId,
    });
  }
}

export async function importGltf(
  data: Uint8Array | string,
  format: GltfFormat,
  resourceFiles: GltfResourceFile[] = [],
): Promise<GltfImportResult> {
  const io = new WebIO();
  let jsonDocument;
  if (format === "glb") {
    jsonDocument = await io.binaryToJSON(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
  } else {
    const json = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (const resource of resourceFiles) {
      resources[resource.name] = resource.data as Uint8Array<ArrayBuffer>;
      const basename = resource.name.split(/[\\/]/).at(-1);
      if (basename) resources[basename] = resource.data as Uint8Array<ArrayBuffer>;
    }
    const sourceBuffers = Array.isArray(json.buffers) ? (json.buffers as { uri?: string }[]) : [];
    for (const buffer of sourceBuffers) {
      if (!buffer.uri || buffer.uri.startsWith("data:")) continue;
      const basename = decodeURIComponent(buffer.uri.split(/[\\/]/).at(-1) ?? buffer.uri);
      const resource = resourceFiles.find((file) => file.name === basename || file.name.endsWith(`/${basename}`));
      if (resource) resources[buffer.uri] = resource.data as Uint8Array<ArrayBuffer>;
    }
    jsonDocument = { json, resources };
  }

  const omittedContent = stripUnsupportedGltfData(jsonDocument.json as unknown as Record<string, unknown>);
  const gltfDocument = await io.readJSON(jsonDocument);
  const root = gltfDocument.getRoot();
  const sourceScene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!sourceScene) throw new Error("The glTF file does not contain a scene.");

  omittedContent.push(...reportUnsupportedContent(root));
  const materials = root.listMaterials().map((material, index) => ({
    id: createId("material", index),
    name: material.getName() || `Material ${index + 1}`,
    baseColor: [...material.getBaseColorFactor()] as [number, number, number, number],
    metallic: material.getMetallicFactor(),
    roughness: material.getRoughnessFactor(),
  }));
  const materialIds = new Map(root.listMaterials().map((material, index) => [material, materials[index].id]));
  const nodes: ModelingDocument["objects"] = [];
  const nodeIds = new Map<ReturnType<typeof sourceScene.listChildren>[number], string>();
  const allSourceNodes: ReturnType<typeof sourceScene.listChildren> = [];
  sourceScene.traverse((node) => allSourceNodes.push(node));
  allSourceNodes.forEach((node, index) => nodeIds.set(node, createId("object", index)));

  allSourceNodes.forEach((node, objectIndex) => {
    const vertices: { id: string; position: [number, number, number] }[] = [];
    const faces: { id: string; vertexIds: string[]; materialId: string | null }[] = [];
    const mesh = node.getMesh();
    mesh?.listPrimitives().forEach((primitive, primitiveIndex) => {
      appendPrimitive(
        primitive,
        vertices,
        faces,
        materialIds.get(primitive.getMaterial()!) ?? null,
        objectIndex,
        primitiveIndex,
        omittedContent,
      );
    });

    const edges: { id: string; vertexIds: [string, string] }[] = [];
    const edgeKeys = new Set<string>();
    for (const face of faces) {
      for (let index = 0; index < face.vertexIds.length; index += 1) {
        const first = face.vertexIds[index];
        const second = face.vertexIds[(index + 1) % face.vertexIds.length];
        const key = first < second ? `${first}:${second}` : `${second}:${first}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ id: createId(`gltf-e${objectIndex + 1}`, edges.length), vertexIds: [first, second] });
      }
    }

    nodes.push({
      id: nodeIds.get(node)!,
      name: node.getName() || `Object ${objectIndex + 1}`,
      transform: {
        position: [...node.getTranslation()],
        rotation: [...node.getRotation()],
        scale: [...node.getScale()],
      },
      mesh: mesh
        ? {
            id: createId("mesh", objectIndex),
            vertices,
            edges,
            faces: faces.filter((face) => face.vertexIds.length === 3),
          }
        : null,
      visible: true,
      parentId: node.getParentNode() ? (nodeIds.get(node.getParentNode()!) ?? null) : null,
    });
  });

  const sceneId = "scene-main";
  const importedDocument: ModelingDocument = {
    schemaVersion: 1,
    id: "gltf-import",
    name: sourceScene.getName() || "Imported glTF scene",
    activeSceneId: sceneId,
    scenes: [{ id: sceneId, name: sourceScene.getName() || "Scene", objectIds: nodes.map(({ id }) => id) }],
    objects: nodes,
    materials,
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
  const canonicalDocument = deserializeModelingDocument(serializeModelingDocument(importedDocument));
  return {
    document: canonicalDocument,
    omittedContent,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function createExportMesh(
  document: Document,
  object: ModelingObject,
  materialMap: Map<string, ReturnType<Document["createMaterial"]>>,
) {
  if (!object.mesh) return null;
  const gltfMesh = document.createMesh(object.name);
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const vertexIndex = new Map(object.mesh.vertices.map((vertex, index) => [vertex.id, index]));
  const materialIds = new Set(object.mesh.faces.map(({ materialId }) => materialId));
  for (const materialId of materialIds) {
    const faces = object.mesh.faces.filter((face) => face.materialId === materialId);
    if (!faces.length) continue;
    const positions = new Float32Array(object.mesh.vertices.flatMap(({ position }) => position));
    const triangleIndices: number[] = [];
    for (const face of faces) {
      const indices = face.vertexIds
        .map((id) => vertexIndex.get(id))
        .filter((index): index is number => index !== undefined);
      for (let index = 1; index + 1 < indices.length; index += 1) {
        triangleIndices.push(indices[0], indices[index], indices[index + 1]);
      }
    }
    const primitive = document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        document.createAccessor().setType(Accessor.Type.VEC3).setArray(positions).setBuffer(buffer),
      )
      .setIndices(
        document
          .createAccessor()
          .setType(Accessor.Type.SCALAR)
          .setArray(new Uint32Array(triangleIndices))
          .setBuffer(buffer),
      )
      .setMode(Primitive.Mode.TRIANGLES);
    const material = materialId ? materialMap.get(materialId) : undefined;
    if (material) primitive.setMaterial(material);
    gltfMesh.addPrimitive(primitive);
  }
  return gltfMesh;
}

export async function exportGltf(documentModel: ModelingDocument, format: GltfFormat): Promise<GltfExportResult> {
  const gltf = new Document();
  const scene = gltf.createScene(documentModel.name);
  const materialMap = new Map(
    documentModel.materials.map((material) => [
      material.id,
      gltf
        .createMaterial(material.name)
        .setBaseColorFactor(material.baseColor)
        .setMetallicFactor(material.metallic)
        .setRoughnessFactor(material.roughness),
    ]),
  );
  const nodeMap = new Map(
    documentModel.objects.map((object) => [
      object.id,
      gltf
        .createNode(object.name)
        .setTranslation(object.transform.position)
        .setRotation(object.transform.rotation)
        .setScale(object.transform.scale)
        .setMesh(createExportMesh(gltf, object, materialMap)),
    ]),
  );
  for (const object of documentModel.objects) {
    const node = nodeMap.get(object.id)!;
    const parent = object.parentId ? nodeMap.get(object.parentId) : undefined;
    if (parent) parent.addChild(node);
    else scene.addChild(node);
  }

  const io = new WebIO();
  const omittedContent: string[] = [];
  const hiddenObjects = documentModel.objects.filter((object) => !object.visible).length;
  if (hiddenObjects) omittedContent.push(`${hiddenObjects} hidden object(s) were exported without visibility state.`);
  if (format === "glb") {
    return {
      data: await io.writeBinary(gltf),
      mimeType: "model/gltf-binary",
      extension: "glb",
      omittedContent,
    };
  }
  const { json, resources } = await io.writeJSON(gltf);
  const [resourceName, resource] = Object.entries(resources)[0] ?? [];
  if (resource && json.buffers?.[0]) {
    json.buffers[0].uri = `data:application/octet-stream;base64,${base64(resource)}`;
  }
  if (resourceName && Object.keys(resources).length > 1) {
    throw new Error("The glTF exporter produced multiple external resources.");
  }
  return {
    data: JSON.stringify(json),
    mimeType: "model/gltf+json",
    extension: "gltf",
    omittedContent,
  };
}