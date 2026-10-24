import type { ModelingDocument } from "@open-3d/model-core";

export interface AffectedObject {
  id: string;
  name: string;
  previousName?: string;
  kind: "created" | "updated" | "deleted";
}

/** Compare validated base and full batch preview, not individual command claims. */
export function summarizeObjectChanges(base: ModelingDocument, preview: ModelingDocument): AffectedObject[] {
  const before = new Map(base.objects.map((object) => [object.id, object]));
  const after = new Map(preview.objects.map((object) => [object.id, object]));
  const result: AffectedObject[] = [];
  for (const [id, object] of after) {
    const old = before.get(id);
    if (!old || JSON.stringify(old) !== JSON.stringify(object))
      result.push({
        id,
        name: object.name.slice(0, 160),
        kind: old ? "updated" : "created",
        ...(old && old.name !== object.name ? { previousName: old.name.slice(0, 160) } : {}),
      });
  }
  for (const [id, object] of before)
    if (!after.has(id)) result.push({ id, name: object.name.slice(0, 160), kind: "deleted" });
  return result;
}