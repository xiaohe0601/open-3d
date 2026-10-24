import { expect, test } from "vite-plus/test";
import { captureSceneEvidence } from "./scene-evidence";
import { createProcessor, emptyDocument } from "../../workspace/modeling";

test("native scene evidence is canonical and captures before asynchronous hashing", async () => {
  const document = emptyDocument();
  const original = structuredClone(document);
  const pending = captureSceneEvidence(document);
  document.name = "Edited after capture";
  const captured = await pending;
  expect(captured).toEqual(await captureSceneEvidence(original));
  expect(captured).not.toEqual(await captureSceneEvidence(document));
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as typeof original;
  expect(captured).toEqual(await captureSceneEvidence(reordered));
  expect(captured.digest).toMatch(/^[a-f0-9]{64}$/);
});

test("scene changes and unsaved AI results cannot be established from document identity", async () => {
  const processor = createProcessor();
  const before = processor.getDocumentSnapshot();
  processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "AI box" } });
  const after = processor.getDocumentSnapshot();
  expect(after.id).toBe(before.id);
  expect(await captureSceneEvidence(after)).not.toEqual(await captureSceneEvidence(before));
  expect(processor.historyLength).toBe(1);
  expect(processor.getDocumentSnapshot()).toEqual(after);
});