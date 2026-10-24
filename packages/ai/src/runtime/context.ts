import type { ModelingObject } from "@open-3d/model-core";
import type { HostSnapshot } from "./ports.ts";

export const MAX_OBJECT_REFERENCES = 20;

export interface ObjectReference {
  objectRevision?: number;
  id: string;
  name: string;
  scopeId: string;
  generationId: string;
}

export interface ResolvedObjectReference extends ObjectReference {
  currentName: string;
  parentId: string | null;
  visible: boolean;
  transform: ModelingObject["transform"];
  topology: { vertices: number; edges: number; faces: number } | null;
}

export class ModraContextError extends Error {
  constructor(readonly code: "context-reference" | "context-limit" | "output-limit") {
    super(code);
    this.name = "ModraContextError";
  }
}

/** Resolve only stable IDs in the originating workspace; labels never identify objects. */
export function resolveObjectReferences(
  references: readonly ObjectReference[],
  scene: HostSnapshot,
): ResolvedObjectReference[] {
  if (references.length > MAX_OBJECT_REFERENCES || new Set(references.map((ref) => ref.id)).size !== references.length)
    throw new ModraContextError("context-reference");
  const objects = new Map(scene.document.objects.map((object) => [object.id, object]));
  return references.map((ref) => {
    const object = objects.get(ref.id);
    if (
      !object ||
      ref.scopeId !== scene.version.scopeId ||
      ref.generationId !== scene.version.generationId ||
      (ref.objectRevision ?? 0) !== (scene.objectRevisions?.[ref.id] ?? 0) ||
      typeof ref.name !== "string" ||
      ref.name.length > 160
    )
      throw new ModraContextError("context-reference");
    return {
      id: object.id,
      name: ref.name,
      scopeId: ref.scopeId,
      generationId: ref.generationId,
      objectRevision: ref.objectRevision ?? 0,
      currentName: object.name.slice(0, 160),
      parentId: object.parentId,
      visible: object.visible,
      transform: structuredClone(object.transform),
      topology: object.mesh
        ? {
            vertices: object.mesh.vertices.length,
            edges: object.mesh.edges.length,
            faces: object.mesh.faces.length,
          }
        : null,
    };
  });
}