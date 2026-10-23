import { Box, Circle, Cylinder, Shapes } from "lucide-react";
import type { ModelingObject } from "@open-3d/model-core";

// Classify the stored topology, not translated/editable object names or transient creation state.
export function objectShape(mesh: ModelingObject["mesh"]): "box" | "sphere" | "cylinder" | "mesh" {
  if (!mesh) return "mesh";
  const sizes = mesh.faces.map((face) => face.vertexIds.length);
  const quads = sizes.filter((size) => size === 4).length;
  if (mesh.vertices.length === 8 && sizes.length === 6 && quads === 6) return "box";
  const segments = mesh.vertices.length / 2;
  if (
    Number.isInteger(segments) &&
    segments >= 3 &&
    sizes.length === segments + 2 &&
    quads >= segments &&
    sizes.filter((size) => size === segments).length >= 2
  )
    return "cylinder";
  const triangles = sizes.filter((size) => size === 3).length;
  if (
    triangles >= 6 &&
    triangles % 2 === 0 &&
    triangles + quads === sizes.length &&
    sizes.length === (triangles / 2) * Math.max(2, Math.floor(triangles / 4)) &&
    mesh.vertices.length === sizes.length - triangles / 2 + 2
  )
    return "sphere";
  return "mesh";
}

export function ObjectIcon({ mesh, className }: { mesh: ModelingObject["mesh"]; className?: string }) {
  const icons = { box: Box, sphere: Circle, cylinder: Cylinder, mesh: Shapes };
  const shape = objectShape(mesh);
  const Icon = icons[shape];
  return <Icon className={className ?? "size-4"} data-object-shape={shape} />;
}