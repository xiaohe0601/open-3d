import type { ModelingDocument } from "@open-3d/model-core";

export function describeSelection(document: ModelingDocument) {
  const { selection } = document;
  const objects = document.objects.filter((object) => selection.objectIds.includes(object.id));
  if (selection.mode !== "object") {
    const active = document.objects.find((object) => object.id === selection.activeObjectId);
    if (active && selection.componentIds.length)
      return {
        kind: "components" as const,
        name: active.name,
        mode: selection.mode,
        count: selection.componentIds.length,
      };
    return { kind: "empty" as const };
  }
  if (!objects.length) return { kind: "empty" as const };
  return { kind: "objects" as const, names: objects.map((object) => object.name).join(", ") };
}