import type { CommandRequest, ModelingCommandProcessor, ModelingDocument } from "@open-3d/model-core";
import {
  sameHostVersion,
  type ChangeSet,
  type HostSnapshot,
  type HostVersion,
  type ModelingHostPort,
} from "@open-3d/ai/runtime";

export type WorkspaceHostEvent =
  | { type: "preview"; document: ModelingDocument | null }
  | {
      type: "changed";
      reason: "manual" | "applied" | "undo" | "redo" | "replace" | "detach" | "transient";
      version: HostVersion;
      changeSetId?: string;
      abandonedScopeId?: string;
      effects: readonly { id: string; effect: ChangeSet["effect"] }[];
    };

/** Owns the synchronous scene boundary; React revisions and document IDs are not version tokens. */
export class WorkspaceModelingHost implements ModelingHostPort {
  #processor: ModelingCommandProcessor;
  #version: HostVersion;
  readonly #newId: () => string;
  readonly #listeners = new Set<(event: WorkspaceHostEvent) => void>();
  readonly #applied = new Set<string>();
  #history: (string | null)[];
  #redo: (string | null)[] = [];
  #previewId: string | null = null;
  #transient = false;
  #savedProjectId: string | undefined;
  #objectRevisions: Record<string, number> = {};
  #viewportCapture: (() => Promise<Blob>) | undefined;

  setViewportCapture(capture: (() => Promise<Blob>) | undefined) {
    this.#viewportCapture = capture;
  }

  async captureViewport(): Promise<Blob> {
    if (!this.#viewportCapture) throw new Error("viewport-capture-unavailable");
    return this.#viewportCapture();
  }

  constructor(processor: ModelingCommandProcessor, scopeId: string, newId: () => string) {
    if (!scopeId) throw new Error("A scene scope is required.");
    this.#processor = processor;
    this.#newId = newId;
    this.#version = { generationId: newId(), scopeId, mutationVersion: 0 };
    this.#history = Array<string | null>(processor.historyLength).fill(null);
  }

  get processor() {
    return this.#processor;
  }
  get savedProjectId() {
    return this.#savedProjectId;
  }
  get transient() {
    return this.#transient;
  }

  snapshot(): HostSnapshot {
    return {
      version: { ...this.#version },
      document: this.#processor.getDocumentSnapshot(),
      transient: this.#transient,
      objectRevisions: { ...this.#objectRevisions },
    };
  }

  subscribe(listener: (event: WorkspaceHostEvent) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(event: WorkspaceHostEvent) {
    for (const listener of this.#listeners) {
      // A broken view subscriber cannot turn a completed scene commit into an apparent failure.
      try {
        listener(event);
      } catch {
        /* Scene authority must not depend on a subscriber. */
      }
    }
  }

  #clearPreview() {
    if (!this.#previewId) return;
    this.#previewId = null;
    this.#notify({ type: "preview", document: null });
  }

  #changed(
    reason: Extract<WorkspaceHostEvent, { type: "changed" }>["reason"],
    changeSetId?: string,
    effects: Extract<WorkspaceHostEvent, { type: "changed" }>["effects"] = [],
    abandonedScopeId?: string,
  ) {
    this.#clearPreview();
    this.#notify({ type: "changed", reason, version: { ...this.#version }, changeSetId, effects, abandonedScopeId });
  }

  #record(id: string | null) {
    // Later commands can alter earlier effects. Without snapshot evidence, report unknown conservatively.
    const discarded = [...this.#history, ...this.#redo].filter((item): item is string => item !== null);
    this.#redo = [];
    this.#history.push(id);
    while (this.#history.length > this.#processor.historyLength) {
      const dropped = this.#history.shift();
      if (dropped) discarded.push(dropped);
    }
    return [...new Set(discarded)].map((item) => ({ id: item, effect: "unknown" as const }));
  }

  #invalidateReferences(before: ModelingDocument, commands: readonly CommandRequest[] = []) {
    const remaining = new Set(this.#processor.getDocumentSnapshot().objects.map((object) => object.id));
    const deleted = new Set(before.objects.filter((object) => !remaining.has(object.id)).map((object) => object.id));
    // Core IDs can be reused within one atomic delete/create batch, so inspect explicit deletions too.
    for (const command of commands) {
      if (command.commandId !== "object.delete") continue;
      const ids = (command.arguments as { objectIds?: string[] }).objectIds ?? [];
      for (const id of ids) deleted.add(id);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const object of before.objects) {
        if (object.parentId && deleted.has(object.parentId) && !deleted.has(object.id)) {
          deleted.add(object.id);
          changed = true;
        }
      }
    }
    for (const id of deleted) this.#objectRevisions[id] = (this.#objectRevisions[id] ?? 0) + 1;
  }

  #assertVersion(expected: HostVersion) {
    if (this.#transient || !sameHostVersion(expected, this.#version)) throw new Error("stale-change-set");
  }

  preview(id: string, expected: HostVersion, document: ModelingDocument | null) {
    if (document === null) {
      // Old cleanup must not clear another run's preview, even after replacement.
      if (this.#previewId === id) this.#clearPreview();
      return;
    }
    this.#assertVersion(expected);
    if (!id || this.#applied.has(id)) throw new Error("stale-change-set");
    this.#previewId = id;
    this.#notify({ type: "preview", document: structuredClone(document) });
  }

  commit(id: string, expected: HostVersion, commands: readonly CommandRequest[]): HostSnapshot {
    this.#assertVersion(expected);
    if (!id || this.#applied.has(id)) throw new Error("already-applied-change-set");
    // No await between the guards and the processor's atomic whole-batch validation/commit.
    const before = this.#processor.getDocumentSnapshot();
    this.#processor.executeGroup(commands);
    this.#invalidateReferences(before, commands);
    this.#applied.add(id);
    this.#version = { ...this.#version, mutationVersion: this.#version.mutationVersion + 1 };
    const effects = this.#record(id);
    this.#changed("applied", id, [...effects, { id, effect: "present" }]);
    return this.snapshot();
  }

  execute(commands: readonly CommandRequest[]) {
    if (this.#transient) throw new Error("transient-edit-in-progress");
    const before = this.#processor.getDocumentSnapshot();
    this.#processor.executeGroup(commands);
    this.#invalidateReferences(before, commands);
    this.#version = { ...this.#version, mutationVersion: this.#version.mutationVersion + 1 };
    this.#changed("manual", undefined, this.#record(null));
  }

  undo() {
    const before = this.#processor.getDocumentSnapshot();
    if (this.#transient || !this.#processor.undo()) return false;
    this.#invalidateReferences(before);
    const id = this.#history.pop() ?? null;
    this.#redo.push(id);
    this.#version = { ...this.#version, mutationVersion: this.#version.mutationVersion + 1 };
    this.#changed("undo", undefined, id ? [{ id, effect: "undone" }] : []);
    return true;
  }

  redo() {
    const before = this.#processor.getDocumentSnapshot();
    if (this.#transient || !this.#processor.redo()) return false;
    this.#invalidateReferences(before);
    const id = this.#redo.pop() ?? null;
    this.#history.push(id);
    this.#version = { ...this.#version, mutationVersion: this.#version.mutationVersion + 1 };
    this.#changed("redo", undefined, id ? [{ id, effect: "present" }] : []);
    return true;
  }

  beginTransient() {
    if (this.#transient) return false;
    this.#transient = true;
    this.#version = { ...this.#version, mutationVersion: this.#version.mutationVersion + 1 };
    this.#changed("transient");
    return true;
  }

  endTransient(commands?: readonly CommandRequest[]) {
    if (!this.#transient) return;
    this.#transient = false;
    if (commands?.length) this.execute(commands);
  }

  adoptSavedProject(id: string) {
    if (!id) throw new Error("A saved project record ID is required.");
    // First save associates an existing temporary scope; it does not replace its scene.
    this.#savedProjectId = id;
  }

  replace(processor: ModelingCommandProcessor, scopeId: string, savedProjectId?: string) {
    if (!scopeId) throw new Error("A scene scope is required.");
    const generationId = this.#newId();
    if (!generationId || generationId === this.#version.generationId)
      throw new Error("A fresh generation ID is required.");
    const abandonedScope = !this.#savedProjectId ? this.#version.scopeId : undefined;
    this.#processor = processor;
    this.#objectRevisions = {};
    this.#version = { generationId, scopeId, mutationVersion: 0 };
    this.#savedProjectId = savedProjectId;
    this.#transient = false;
    this.#history = Array<string | null>(processor.historyLength).fill(null);
    this.#redo = [];
    this.#changed("replace", undefined, [], abandonedScope);
  }

  detachScope(scopeId: string) {
    const abandonedScope = !this.#savedProjectId ? this.#version.scopeId : undefined;
    if (!scopeId || scopeId === this.#version.scopeId) throw new Error("A fresh temporary scope is required.");
    const generationId = this.#newId();
    if (!generationId || generationId === this.#version.generationId)
      throw new Error("A fresh generation ID is required.");
    this.#version = { generationId, scopeId, mutationVersion: this.#version.mutationVersion };
    this.#savedProjectId = undefined;
    this.#transient = false;
    this.#changed(
      "detach",
      undefined,
      [...this.#applied].map((id) => ({ id, effect: "unknown" })),
      abandonedScope,
    );
  }
}