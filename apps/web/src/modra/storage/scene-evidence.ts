import { serializeNativeProject } from "@open-3d/projects";
import type { ModelingDocument } from "@open-3d/model-core";
import type { SceneEvidence } from "@open-3d/ai/runtime";

export function captureSceneEvidence(document: ModelingDocument): Promise<SceneEvidence> {
  // Canonicalize synchronously: later host edits cannot change the hashed snapshot.
  const bytes = new TextEncoder().encode(serializeNativeProject(document));
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => ({
    algorithm: "sha256-native-v1",
    digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  }));
}