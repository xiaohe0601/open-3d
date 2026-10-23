import { expect, test } from "vite-plus/test";
import { deserializeNativeProject, serializeNativeProject } from "@open-3d/projects";
import { createProcessor, emptyDocument } from "./modeling";
import { objectShape } from "./object-icon";

test.each(["box", "uv-sphere", "cylinder"] as const)(
  "recognizes %s topology after rename, copy and persistence",
  (primitive) => {
    const processor = createProcessor(emptyDocument());
    processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive, name: "Not a type name" } });
    const object = processor.getDocumentSnapshot().objects[0];
    processor.executeCommand({ commandId: "object.duplicate", arguments: { objectId: object.id, name: "重命名" } });
    const document = deserializeNativeProject(serializeNativeProject(processor.getDocumentSnapshot()));
    for (const item of document.objects)
      expect(objectShape(item.mesh)).toBe(primitive === "uv-sphere" ? "sphere" : primitive);
  },
);

test("uses a generic mesh icon for missing and non-primitive topology", () => {
  expect(objectShape(null)).toBe("mesh");
  const processor = createProcessor(emptyDocument());
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box" } });
  const mesh = processor.getDocumentSnapshot().objects[0].mesh!;
  mesh.faces.pop();
  expect(objectShape(mesh)).toBe("mesh");
});