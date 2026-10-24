import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { ModelingCommandProcessor, createCoreCommandHandlers } from "@open-3d/model-core";
import { createMemorySessionRepository, createModraSession, ModraRuntime, sameHostVersion } from "./index.ts";

const emptyDocument = () => ({
  schemaVersion: 1,
  id: "same-document-id",
  name: "Scene",
  activeSceneId: "scene",
  scenes: [{ id: "scene", name: "Scene", objectIds: [] }],
  objects: [],
  materials: [],
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
});
const connection = { providerId: "test", protocol: "openai-compatible", route: "direct" };
const commandName = "command_scene_createPrimitive";
const commandInput = { primitive: "box", name: "Proposed box" };

test("explicit references resolve fresh properties while retaining the attached label and scene version", async () => {
  let history;
  const f = fixture(async function* (request) {
    history = request.history;
    yield { type: "text-delta", text: "Observed" };
  });
  f.processor.executeCommand({ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Original" } });
  const id = f.processor.getDocumentSnapshot().objects[0].id;
  const reference = { id, name: "Original", scopeId: "scope", generationId: "generation-1" };
  f.processor.executeCommand({ commandId: "object.rename", arguments: { objectId: id, name: "Renamed" } });
  await f.runtime.submit({ text: "Inspect this", references: [reference], connection });
  const user = f.runtime.getSnapshot().messages[0];
  assert.equal(user.references[0].name, "Original");
  assert.equal(user.references[0].currentName, "Renamed");
  assert.deepEqual(user.references[0].topology, { vertices: 8, edges: 12, faces: 6 });
  assert.ok(history[0].content.some((part) => part.type === "text" && part.text.includes('"currentName":"Renamed"')));
  assert.equal(user.base.generationId, "generation-1");
});

test.each(["missing", "replaced", "too-many"])(
  "%s references block dispatch without binding by name or changing history",
  async (kind) => {
    const f = fixture(async function* () {
      yield { type: "text-delta", text: "Must not run" };
    });
    f.processor.executeCommand({
      commandId: "scene.createPrimitive",
      arguments: { primitive: "box", name: "Same name" },
    });
    const id = f.processor.getDocumentSnapshot().objects[0].id;
    const reference = {
      id: kind === "missing" ? "not-this-object" : id,
      name: "Same name",
      scopeId: "scope",
      generationId: kind === "replaced" ? "earlier-generation" : "generation-1",
    };
    await assert.rejects(
      f.runtime.submit({
        text: "Inspect",
        references: kind === "too-many" ? Array(21).fill(reference) : [reference],
        connection,
      }),
      { code: "context-reference" },
    );
    assert.equal(f.requests, 0);
    assert.equal(f.runtime.getSnapshot().messages.length, 0);
    assert.equal(f.processor.getDocumentSnapshot().objects.length, 1);
  },
);

function fixture(stream) {
  let serial = 0;
  let now = 0;
  let credentialRevision = "1";
  let version = { generationId: "generation-1", scopeId: "scope", mutationVersion: 0 };
  let processor = new ModelingCommandProcessor(emptyDocument(), { handlers: createCoreCommandHandlers() });
  let preview = null;
  let previewId = null;
  let requests = 0;
  const applied = new Set();
  const repository = createMemorySessionRepository("test-owner", () => now);
  const host = {
    snapshot: () => ({ version: { ...version }, document: processor.getDocumentSnapshot(), transient: false }),
    preview(id, expected, document) {
      if (document) {
        assert.ok(sameHostVersion(expected, version), "preview version must match");
        preview = structuredClone(document);
        previewId = id;
      } else if (previewId === id) {
        preview = null;
        previewId = null;
      }
    },
    commit(id, expected, commands) {
      assert.ok(sameHostVersion(expected, version), "commit version must match");
      assert.equal(applied.has(id), false, "batch must not apply twice");
      processor.executeGroup(commands);
      applied.add(id);
      version.mutationVersion++;
      return host.snapshot();
    },
  };
  const ports = {
    host,
    repository,
    clock: { now: () => now, id: (kind) => `${kind}-${++serial}` },
    credentials: {
      resolve: () => ({ revision: credentialRevision, apiKey: "SECRET-test-key" }),
      isCurrent: (snapshot) => snapshot.revision === credentialRevision,
    },
    transport: {
      fetch: () => {
        throw new Error("Unexpected network");
      },
    },
    provider: {
      stream(request) {
        requests++;
        return stream(request, requests);
      },
    },
  };
  const runtime = new ModraRuntime(createModraSession("session", "scope"), ports);
  return {
    runtime,
    repository,
    ports,
    get processor() {
      return processor;
    },
    get preview() {
      return preview;
    },
    get requests() {
      return requests;
    },
    edit() {
      processor.executeCommand({ commandId: "document.rename", arguments: { name: "Manual edit" } });
      version.mutationVersion++;
      preview = null;
    },
    undo() {
      assert.ok(processor.undo());
      version.mutationVersion++;
      preview = null;
    },
    replace() {
      processor = new ModelingCommandProcessor(emptyDocument(), { handlers: createCoreCommandHandlers() });
      version = { ...version, generationId: "generation-2", mutationVersion: 0 };
      preview = null;
    },
    removeCredential() {
      credentialRevision = "removed";
    },
    advance(ms) {
      now += ms;
    },
  };
}

test("non-DOM runtime queries, previews, reviews, persists and continues using neutral ports", async () => {
  const f = fixture(async function* (request, round) {
    yield { type: "step-start" };
    if (round === 1) {
      assert.equal(request.executeTool("query", "query_scene_getHierarchy", { limit: 10 }).kind, "query");
      request.executeTool("create", commandName, commandInput);
      const hierarchy = request.executeTool("preview-query", "query_scene_getHierarchy", { limit: 10 });
      assert.equal(hierarchy.result.items.length, 1);
      yield { type: "text-delta", text: "Review the box" };
    } else {
      assert.equal(request.scene.document.objects.length, 1);
      assert.ok(
        request.history.some((message) =>
          message.content.some((part) => part.type === "application-outcome" && part.decision === "applied"),
        ),
      );
      yield { type: "text-delta", text: "Done" };
    }
  });
  let notifications = 0;
  const unsubscribe = f.runtime.subscribe(() => notifications++);
  await f.runtime.submit({ text: "Make a box", connection });
  assert.equal(f.runtime.getSnapshot().run.phase, "awaiting-review");
  assert.equal(f.processor.getDocumentSnapshot().objects.length, 0);
  assert.equal(f.preview.objects.length, 1);
  const id = f.runtime.getSnapshot().changeSets[0].id;
  await f.runtime.accept(id);
  assert.equal(f.requests, 2);
  assert.equal(f.processor.historyLength, 1);
  assert.equal(f.runtime.getSnapshot().run.phase, "completed");
  assert.equal(f.preview, null);
  assert.ok(notifications > 5);
  unsubscribe();
  const durable = f.repository.load("session");
  assert.equal(JSON.stringify(durable).includes("SECRET-test-key"), false);
  assert.equal(durable.changeSets[0].status, "applied");
  await f.runtime.accept(id);
  assert.equal(f.processor.historyLength, 1);
  assert.equal(f.requests, 2);
});

test.each(["request", "auto"])(
  "failure with valid partial work in %s mode supports Keep without continuation",
  async (approval) => {
    const f = fixture(async function* (request) {
      request.executeTool("create", commandName, commandInput);
      yield { type: "text-delta", text: "Partial work" };
      throw new TypeError("SECRET-test-key should not leak into state");
    });
    await f.runtime.submit({ text: "Make a box", connection, approval });
    const state = f.runtime.getSnapshot();
    assert.equal(state.run.phase, "awaiting-review");
    assert.equal(state.run.outcome, "failed");
    assert.equal(state.changeSets[0].interrupted, true);
    assert.equal(f.processor.historyLength, 0);
    await f.runtime.accept(state.changeSets[0].id);
    assert.equal(f.requests, 1);
    assert.equal(f.processor.historyLength, 1);
    assert.equal(f.preview, null);
    assert.equal(f.runtime.getSnapshot().run.phase, "failed");
    assert.equal(JSON.stringify(f.runtime.getSnapshot()).includes("SECRET-test-key"), false);
  },
);

test("Discard retains transcript and does not apply or request anything", async () => {
  const f = fixture(async function* (request) {
    request.executeTool("create", commandName, commandInput);
    yield { type: "error", error: new Error("network") };
  });
  await f.runtime.submit({ text: "box", connection });
  await f.runtime.reject(f.runtime.getSnapshot().changeSets[0].id);
  assert.equal(f.preview, null);
  assert.equal(f.requests, 1);
  assert.equal(f.processor.historyLength, 0);
  assert.equal(f.runtime.getSnapshot().changeSets[0].status, "rejected");
});

test("automatic continuations use a bounded loop with exactly 20 applied batches", async () => {
  const f = fixture(async function* (request) {
    yield { type: "step-start" };
    request.executeTool("create", commandName, commandInput);
  });
  await f.runtime.submit({ text: "Keep creating", connection, approval: "auto" });
  assert.equal(f.processor.historyLength, 20);
  assert.equal(f.requests, 20);
  assert.equal(f.runtime.getSnapshot().changeSets.filter((change) => change.status === "applied").length, 20);
  assert.equal(f.runtime.getSnapshot().run.phase, "completed");
  assert.equal(f.runtime.getSnapshot().run.error, "batch-limit");
});

test("tool errors stop further tool execution; duplicate completed call IDs do not create a second proposal", async () => {
  const f = fixture(async function* (request) {
    const first = request.executeTool("create", commandName, commandInput);
    assert.deepEqual(request.executeTool("create", commandName, commandInput), first);
    assert.throws(() => request.executeTool("bad", "unknown_tool", {}));
    assert.throws(() => request.executeTool("after-error", commandName, commandInput));
    yield { type: "text-delta", text: "Invalid operation" };
  });
  await f.runtime.submit({ text: "box", connection });
  const state = f.runtime.getSnapshot();
  assert.equal(state.run.outcome, "failed");
  assert.equal(state.changeSets[0].commands.length, 1);
  assert.equal(state.messages[1].toolCalls.filter((tool) => tool.status === "completed").length, 1);
  assert.equal(state.messages[1].toolCalls.filter((tool) => tool.status === "failed").length, 1);
  assert.equal(f.processor.historyLength, 0);
});

test("Plan rejects commands under Auto-approve and the run stops at the 20-step boundary", async () => {
  const plan = fixture(async function* (request) {
    request.executeTool("bad", commandName, commandInput);
    yield { type: "text-delta", text: "Unreachable" };
  });
  await plan.runtime.submit({ text: "plan", connection, mode: "plan", approval: "auto" });
  assert.equal(plan.processor.historyLength, 0);
  assert.equal(plan.preview, null);
  assert.equal(plan.runtime.getSnapshot().run.outcome, "failed");
  const steps = fixture(async function* () {
    for (let i = 0; i < 21; i++) yield { type: "step-start" };
  });
  await steps.runtime.submit({ text: "budget", connection });
  assert.equal(steps.runtime.getSnapshot().run.error, "step-limit");
});

test.each(["edit", "undo", "replace"])("%s before review makes manual host application stale", async (action) => {
  const f = fixture(async function* (request) {
    yield { type: "step-start" };
    request.executeTool("create", commandName, commandInput);
  });
  await f.runtime.submit({ text: "box", connection });
  if (action === "undo") f.edit();
  f[action]();
  const before = f.processor.getDocumentSnapshot();
  await f.runtime.accept(f.runtime.getSnapshot().changeSets[0].id);
  assert.deepEqual(f.processor.getDocumentSnapshot(), before);
  assert.equal(f.runtime.getSnapshot().changeSets[0].status, "stale");
  assert.equal(f.requests, 1);
});

test("cancellation settles a non-cooperative provider, blocks late tools and preserves terminal state", async () => {
  let request;
  let resolveNext;
  let returned = false;
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const f = fixture((value) => {
    request = value;
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            ready();
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true });
          },
        };
      },
    };
  });
  const work = f.runtime.submit({ text: "cancel", connection });
  await started;
  f.runtime.cancel();
  await work;
  const before = f.runtime.getSnapshot();
  assert.equal(before.run.phase, "cancelled");
  assert.ok(returned);
  assert.throws(() => request.executeTool("late", commandName, commandInput));
  resolveNext({ value: { type: "text-delta", text: "late" }, done: false });
  await Promise.resolve();
  assert.equal(f.runtime.getSnapshot(), before);
  assert.equal(f.preview, null);
});

test("credential removal and ownership loss prevent later tool calls or retries", async () => {
  for (const cause of ["credential", "ownership"]) {
    let f;
    f = fixture(async function* (request) {
      if (cause === "credential") f.removeCredential();
      else await f.repository.acquire("session", "scope");
      assert.throws(request.assertActive);
      request.executeTool("blocked", commandName, commandInput);
      yield { type: "text-delta", text: "Unreachable" };
    });
    const work = f.runtime.submit({ text: "box", connection });
    if (cause === "ownership") await assert.rejects(work, /session-ownership-lost/);
    else await work;
    assert.equal(f.processor.historyLength, 0);
    assert.equal(f.preview, null);
    assert.equal(f.runtime.getSnapshot().run.phase, "stale");
  }
});

test("the execution lane is claimed before asynchronous ownership acquisition", async () => {
  const f = fixture(async function* () {
    yield { type: "text-delta", text: "Done" };
  });
  const first = f.runtime.submit({ text: "one", connection });
  await assert.rejects(f.runtime.submit({ text: "two", connection }), /busy/);
  await first;
  assert.equal(f.requests, 1);
});

test("invalidation clears a completed review preview and cannot clear another change set", async () => {
  const f = fixture(async function* (request) {
    request.executeTool("create", commandName, commandInput);
    yield { type: "text-delta", text: "Review" };
  });
  await f.runtime.submit({ text: "box", connection });
  assert.ok(f.preview);
  f.runtime.invalidate();
  assert.equal(f.preview, null);
  assert.equal(f.runtime.getSnapshot().changeSets[0].status, "stale");
  const newer = f.ports.host.snapshot();
  f.ports.host.preview("another-change", newer.version, newer.document);
  f.runtime.invalidate();
  assert.ok(f.preview);
});

test.each([
  [{ statusCode: 401 }, "auth"],
  [new TypeError("Failed to fetch"), "network"],
  [new Error("Tool schema validation failed"), "protocol"],
  [new Error("Provider refused"), "request"],
])("provider failures persist only classified codes: %s", async (error, code) => {
  const f = fixture(async function* () {
    yield { type: "error", error };
  });
  await f.runtime.submit({ text: "test", connection });
  assert.equal(f.runtime.getSnapshot().run.error, code);
});

test("terminal persistence retains the execution lane until the final write settles", async () => {
  const f = fixture(async function* () {
    yield { type: "text-delta", text: "Done" };
  });
  const save = f.ports.repository.save.bind(f.ports.repository);
  let release;
  let reached;
  const terminal = new Promise((resolve) => {
    reached = resolve;
  });
  f.ports.repository.save = async (state, owner) => {
    if (state.run?.outcome === "completed") {
      reached();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    await save(state, owner);
  };
  const first = f.runtime.submit({ text: "one", connection });
  await terminal;
  await assert.rejects(f.runtime.submit({ text: "two", connection }), /busy/);
  release();
  await first;
});

test("review still checks the completed run credential snapshot even before adapter invalidation", async () => {
  const f = fixture(async function* (request) {
    request.executeTool("create", commandName, commandInput);
    yield { type: "text-delta", text: "Review" };
  });
  await f.runtime.submit({ text: "box", connection });
  f.removeCredential();
  await f.runtime.accept(f.runtime.getSnapshot().changeSets[0].id);
  assert.equal(f.processor.historyLength, 0);
  assert.equal(f.preview, null);
  assert.equal(f.requests, 1);
  assert.equal(f.runtime.getSnapshot().changeSets[0].status, "stale");
});

test("broken view subscribers cannot interrupt runtime transitions", async () => {
  const f = fixture(async function* () {
    yield { type: "text-delta", text: "Done" };
  });
  f.runtime.subscribe(() => {
    throw new Error("view failed");
  });
  await f.runtime.submit({ text: "hello", connection });
  assert.equal(f.runtime.getSnapshot().run.outcome, "completed");
});
test("opaque tool metadata and optional usage survive completion and same-protocol continuation only", async () => {
  const f = fixture(async function* (request, round) {
    if (round === 1) {
      yield { type: "tool-preparing", id: "query", name: "query_scene_getHierarchy" };
      yield { type: "tool-metadata", id: "query", metadata: { google: { thoughtSignature: "opaque-signature" } } };
      request.executeTool("query", "query_scene_getHierarchy", { limit: 10 });
      yield { type: "usage", inputTokens: 4, outputTokens: 2 };
    } else {
      const call = request.history.flatMap((message) => message.content).find((part) => part.type === "tool-call");
      assert.deepEqual(call.metadata, round === 2 ? { google: { thoughtSignature: "opaque-signature" } } : undefined);
      yield { type: "text-delta", text: "Done" };
    }
  });
  await f.runtime.submit({ text: "Inspect", connection: { ...connection, protocol: "gemini" } });
  const state = f.runtime.getSnapshot();
  assert.equal(state.messages.at(-1).toolCalls[0].status, "completed");
  assert.equal(state.messages.at(-1).toolCalls[0].providerMetadata.protocol, "gemini");
  assert.deepEqual(state.run.usage, { inputTokens: 4, outputTokens: 2 });
  await f.runtime.submit({ text: "Continue inspecting", connection: { ...connection, protocol: "gemini" } });
  assert.equal(f.runtime.getSnapshot().run.usage, undefined);
  await f.runtime.submit({ text: "Switch provider", connection });
  assert.equal(f.processor.historyLength, 0);
});

test("stream persistence coalesces deltas and flushes the final terminal snapshot", async () => {
  vi.useFakeTimers();
  try {
    let release;
    let started;
    const streaming = new Promise((resolve) => {
      started = resolve;
    });
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture(async function* () {
      for (let index = 0; index < 500; index++) yield { type: "text-delta", text: "x" };
      started();
      await waiting;
      yield { type: "text-delta", text: "final" };
    });
    const save = vi.spyOn(f.repository, "save");
    const work = f.runtime.submit({ text: "Stream", connection });
    await streaming;
    assert.equal(save.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(save.mock.calls.length, 1);
    assert.equal(f.repository.load("session").messages.at(-1).text.length, 500);
    release();
    await work;
    assert.equal(save.mock.calls.length, 2);
    assert.equal(f.repository.load("session").run.phase, "completed");
    assert.ok(f.repository.load("session").messages.at(-1).text.endsWith("final"));
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(save.mock.calls.length, 2);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

test("terminal storage failure preserves active text and image references without reporting durable success", async () => {
  const f = fixture(async function* () {
    yield { type: "text-delta", text: "Keep this response" };
  });
  f.repository.save = async () => {
    throw new Error("storage-quota");
  };
  const asset = { assetId: "image", name: "reference.png", mediaType: "image/png", byteLength: 3 };
  await assert.rejects(f.runtime.submit({ text: "Inspect", assets: [asset], connection }), /storage-quota/);
  assert.deepEqual(f.runtime.getSnapshot().messages[0].assets, [asset]);
  assert.equal(f.runtime.getSnapshot().messages.at(-1).text, "Keep this response");
  await assert.rejects(f.runtime.flush(), /storage-quota/);
});

test("durable guards block tools and host commits when the transactional lease was lost", async () => {
  const f = fixture(async function* (request) {
    await request.executeTool("create", commandName, commandInput);
    yield { type: "text-delta", text: "Review" };
  });
  f.repository.guarded = async (_owner, action) => action();
  await f.runtime.submit({ text: "Box", connection });
  assert.ok(f.preview);
  f.repository.guarded = async () => {
    throw new Error("fenced");
  };
  await f.runtime.accept(f.runtime.getSnapshot().changeSets[0].id);
  assert.equal(f.processor.historyLength, 0);
  assert.equal(f.preview, null);
  assert.equal(f.runtime.getSnapshot().changeSets[0].status, "stale");
  await f.runtime.submit({ text: "Box again", connection });
  assert.equal(f.runtime.getSnapshot().run.error, "ownership-lost");
  assert.equal(f.processor.historyLength, 0);
});

test.each(["available", "lost"])(
  "a committed batch retains its historical decision when evidence is %s",
  async (availability) => {
    const f = fixture(async function* (request, round) {
      if (round === 1) await request.executeTool("create", commandName, commandInput);
      else yield { type: "text-delta", text: "Done" };
    });
    f.ports.evidence = {
      capture: async (document) => {
        assert.equal(document.objects.length, 1);
        if (availability === "lost") throw new Error("hash-unavailable");
        return { algorithm: "sha256-native-v1", digest: "a".repeat(64) };
      },
    };
    await f.runtime.submit({ text: "Box", connection });
    await f.runtime.accept(f.runtime.getSnapshot().changeSets[0].id);
    const applied = f.runtime.getSnapshot().changeSets[0];
    assert.equal(applied.status, "applied");
    assert.equal(applied.evidence?.digest, availability === "available" ? "a".repeat(64) : undefined);
    assert.equal(f.processor.historyLength, 1);
    assert.equal(f.requests, 2);
  },
);

test.each(["manual edit", "undo", "replace", "credentials", "ownership", "cancel"])(
  "an asynchronous receipt cannot continue a task after %s without a host subscriber",
  async (interruption) => {
    let hashing;
    const started = new Promise((resolve) => {
      hashing = resolve;
    });
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture(async function* (request) {
      await request.executeTool("create", commandName, commandInput);
      yield { type: "text-delta", text: "Review" };
    });
    f.ports.evidence = {
      capture: async () => {
        hashing();
        await pending;
        return { algorithm: "sha256-native-v1", digest: "b".repeat(64) };
      },
    };
    await f.runtime.submit({ text: "Box", connection });
    const id = f.runtime.getSnapshot().changeSets[0].id;
    const work = f.runtime.accept(id);
    await started;
    if (interruption === "manual edit") f.edit();
    if (interruption === "undo") f.undo();
    if (interruption === "replace") f.replace();
    if (interruption === "credentials") f.removeCredential();
    if (interruption === "ownership") f.repository.isWritable = () => false;
    if (interruption === "cancel") f.runtime.cancel();
    release();
    await work;
    assert.equal(f.requests, 1);
    assert.equal(f.runtime.getSnapshot().run.phase, interruption === "cancel" ? "cancelled" : "stale");
    const applied = f.runtime.getSnapshot().changeSets[0];
    assert.equal(applied.status, "applied");
    assert.equal(applied.evidence.digest, "b".repeat(64));
    assert.equal(applied.effect, ["manual edit", "undo", "replace"].includes(interruption) ? "unknown" : "present");
  },
);

test("receipt completion never overwrites an explicitly known Undo effect", async () => {
  const f = fixture(async function* (request) {
    await request.executeTool("create", commandName, commandInput);
    yield { type: "text-delta", text: "Review" };
  });
  f.ports.evidence = {
    capture: async () => {
      f.undo();
      const id = f.runtime.getSnapshot().changeSets[0].id;
      f.runtime.updateEffect(id, "undone");
      f.runtime.invalidate();
      return { algorithm: "sha256-native-v1", digest: "c".repeat(64) };
    },
  };
  await f.runtime.submit({ text: "Box", connection });
  await f.runtime.accept(f.runtime.getSnapshot().changeSets[0].id);
  assert.equal(f.runtime.getSnapshot().changeSets[0].effect, "undone");
  assert.equal(f.requests, 1);
});
test("Plan plus Auto exposes bounded progress but cannot preview or mutate, and Build starts fresh", async () => {
  const f = fixture(async function* (request, round) {
    if (round === 1) {
      assert.equal(request.mode, "plan");
      request.executeTool("plan", "update_task_plan", {
        steps: [{ id: "box", label: "Build a box", status: "pending" }],
      });
      yield { type: "text-delta", text: "A plan, not a scene change" };
    } else {
      assert.equal(request.mode, "build");
      assert.equal(request.scene.version.mutationVersion, 1);
      request.executeTool("create", commandName, commandInput);
    }
  });
  await f.runtime.submit({ text: "Plan", mode: "plan", approval: "auto", connection });
  assert.equal(f.processor.getDocumentSnapshot().objects.length, 0);
  assert.equal(f.preview, null);
  assert.equal(f.runtime.getSnapshot().changeSets.length, 0);
  assert.equal(f.runtime.getSnapshot().messages[1].plan.steps[0].id, "box");
  f.edit();
  await f.runtime.submit({ text: "Build that plan", mode: "build", approval: "request", connection });
  assert.equal(f.runtime.getSnapshot().run.phase, "awaiting-review");
  assert.equal(f.runtime.getSnapshot().run.base.mutationVersion, 1);
  assert.equal(f.processor.getDocumentSnapshot().objects.length, 0);
});

test.each(["mutation", "too-many", "duplicate", "identity"])("Plan rejects %s without scene edits", async (kind) => {
  const f = fixture(async function* (request) {
    if (kind === "mutation") request.executeTool("create", commandName, commandInput);
    else {
      const steps = [{ id: "a", label: "First", status: "pending" }];
      request.executeTool("initial", "update_task_plan", { steps });
      request.executeTool("invalid", "update_task_plan", {
        steps:
          kind === "too-many"
            ? Array.from({ length: 21 }, (_, i) => ({ ...steps[0], id: String(i) }))
            : kind === "duplicate"
              ? [steps[0], steps[0]]
              : [{ ...steps[0], id: "new-identity" }],
      });
    }
    yield { type: "text-delta", text: "Must stop" };
  });
  await f.runtime.submit({ text: "Plan", mode: "plan", approval: "auto", connection });
  assert.equal(f.runtime.getSnapshot().run.outcome, "failed");
  assert.equal(f.runtime.getSnapshot().changeSets.length, 0);
  assert.equal(f.processor.historyLength, 0);
  assert.equal(f.preview, null);
});
test("context compaction preserves full transcripts, uses coherent task boundaries and persists across recovery", async () => {
  const requests = [];
  const f = fixture(async function* (request) {
    requests.push(request);
    yield { type: "text-delta", text: "Earlier explanation ".repeat(3500) };
  });
  const summaries = [];
  f.ports.provider.compact = async function* (request) {
    summaries.push(request);
    assert.equal(request.executeTool, undefined);
    assert.deepEqual(request.connection, connection);
    yield "Goal: a 2m box. Earlier explanation summarized. Inspect the current scene before editing.";
  };
  await f.runtime.submit({ text: "First task", connection });
  assert.equal(summaries.length, 0);
  const first = structuredClone(f.runtime.getSnapshot().messages);
  await f.runtime.submit({ text: "Second task", connection });
  assert.equal(summaries.length, 1);
  assert.deepEqual(f.runtime.getSnapshot().messages.slice(0, 2), first);
  assert.equal(f.runtime.getSnapshot().contextCheckpoint.throughMessageId, first[1].id);
  assert.equal(requests[1].history[0].id, "context-checkpoint");
  assert.equal(
    requests[1].history.some((message) => message.id === first[1].id),
    false,
  );
  assert.ok(requests[1].history.some((message) => message.content.some((part) => part.text === "Second task")));
  await f.runtime.submit({ text: "Third task", connection });
  assert.equal(summaries.length, 2);
  assert.equal(f.runtime.getSnapshot().contextCheckpoint.compactions, 2);
  assert.ok(summaries[1].history[0].content[0].text.includes("Earlier explanation summarized"));
  await f.runtime.flush();
  const reopened = new ModraRuntime(structuredClone(f.runtime.getSnapshot()), f.ports);
  await reopened.submit({ text: "Fourth task", connection });
  assert.equal(reopened.getSnapshot().contextCheckpoint.compactions, 3);
  assert.equal(reopened.getSnapshot().messages.length, 8);
  assert.equal(f.processor.historyLength, 0);
  assert.equal(f.preview, null);
});

test.each(["failure", "empty", "oversized", "cancel", "edit", "credentials", "ownership"])(
  "failed or stale compaction (%s) cannot publish a late summary or dispatch modeling",
  async (kind) => {
    const f = fixture(async function* () {
      yield { type: "text-delta", text: "A".repeat(65_000) };
    });
    await f.runtime.submit({ text: "First task", connection });
    const original = structuredClone(f.runtime.getSnapshot().messages);
    const gate = deferred();
    f.ports.provider.compact = async function* () {
      await gate.promise;
      if (kind === "failure") throw new TypeError("Failed to fetch");
      yield kind === "empty" ? " " : kind === "oversized" ? "A".repeat(8192) : "Late summary";
    };
    const task = f.runtime.submit({ text: "Next task", connection });
    await vi.waitFor(() => assert.equal(f.runtime.getSnapshot().run.compacting, true));
    if (kind === "cancel") f.runtime.cancel();
    if (kind === "edit") f.edit();
    if (kind === "credentials") f.removeCredential();
    if (kind === "ownership") f.ports.repository.isWritable = () => false;
    if (kind === "cancel") await task; // A non-cooperative provider must not block cancellation.
    gate.resolve();
    await task;
    await Promise.resolve();
    assert.equal(f.requests, 1);
    assert.equal(f.runtime.getSnapshot().contextCheckpoint, undefined);
    assert.deepEqual(f.runtime.getSnapshot().messages.slice(0, 2), original);
    assert.notEqual(f.runtime.getSnapshot().run.compacting, true);
    assert.notEqual(f.runtime.getSnapshot().run.outcome, "completed");
    assert.equal(f.preview, null);
  },
);

test("a current task too large to fit fails without silently truncating or summarizing the user's request", async () => {
  const f = fixture(async function* () {
    yield { type: "text-delta", text: "Should not run" };
  });
  let summaries = 0;
  f.ports.provider.compact = async function* () {
    summaries++;
    yield "Should not run";
  };
  const prompt = "大".repeat(40_000);
  await f.runtime.submit({ text: prompt, connection });
  assert.equal(f.runtime.getSnapshot().run.error, "context-limit");
  assert.equal(f.runtime.getSnapshot().messages[0].text, prompt);
  assert.equal(f.requests, 0);
  assert.equal(summaries, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

test("FIFO follow-ups wait for the entire auto-approved task and preserve their own policy", async () => {
  const gate = deferred();
  const texts = [];
  const f = fixture(async function* (request, round) {
    texts.push(
      request.history
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .at(-1)?.text,
    );
    if (round === 1) request.executeTool("create", commandName, commandInput);
    if (round === 2) await gate.promise;
    if (round === 3) assert.equal(request.mode, "plan");
    yield { type: "text-delta", text: "Done" };
  });
  const task = f.runtime.submit({ text: "Original", approval: "auto", connection });
  await vi.waitFor(() => assert.equal(f.requests, 2));
  await f.runtime.enqueue({ text: "Next one", mode: "plan", approval: "request", connection });
  await f.runtime.enqueue({ text: "Next two", connection });
  assert.equal(f.requests, 2);
  assert.equal(f.runtime.getSnapshot().queue.entries.length, 2);
  gate.resolve();
  await task;
  assert.equal(f.requests, 4);
  assert.deepEqual(texts.slice(-2), ["Next one", "Next two"]);
  assert.equal(f.runtime.getSnapshot().queue.entries.length, 0);
  assert.equal(f.processor.getDocumentSnapshot().objects.length, 1);
});

test.each(["failure", "cancel", "invalidate", "ownership"])(
  "%s pauses queued work until explicit resume",
  async (kind) => {
    const gate = deferred();
    const f = fixture(async function* (_request, round) {
      if (round === 1) {
        await gate.promise;
        if (kind === "failure") throw new Error("Connection failed");
      }
      yield { type: "text-delta", text: "Done" };
    });
    const task = f.runtime.submit({ text: "Original", connection });
    await vi.waitFor(() => assert.equal(f.requests, 1));
    await f.runtime.enqueue({ text: "Correction", connection });
    if (kind === "cancel") f.runtime.cancel();
    if (kind === "invalidate") f.runtime.invalidate();
    if (kind === "ownership") f.repository.isWritable = () => false;
    gate.resolve();
    await task;
    assert.equal(f.requests, 1);
    assert.equal(f.runtime.getSnapshot().queue.paused, true);
    if (kind === "ownership") {
      await assert.rejects(f.runtime.resumeQueue());
      assert.equal(f.requests, 1);
    } else {
      await f.runtime.resumeQueue();
      assert.equal(f.requests, 2);
      assert.equal(f.runtime.getSnapshot().queue.entries.length, 0);
    }
  },
);

test("failed retained proposals block queues after Keep until explicit resume; queued references revalidate", async () => {
  const f = fixture(async function* (request, round) {
    if (round === 1) {
      request.executeTool("create", commandName, commandInput);
      throw new Error("Failed to fetch");
    }
    yield { type: "text-delta", text: "Done" };
  });
  await f.runtime.submit({ text: "Original", approval: "auto", connection });
  await f.runtime.enqueue({ text: "Correction", connection });
  await assert.rejects(f.runtime.resumeQueue(), { code: "busy" });
  assert.equal(f.requests, 1);
  const change = f.runtime.getSnapshot().changeSets[0];
  await f.runtime.accept(change.id);
  assert.equal(f.requests, 1);
  await f.runtime.resumeQueue();
  assert.equal(f.requests, 2);
  assert.equal(f.processor.getDocumentSnapshot().objects.length, 1);
});
test.each(["text", "tool", "context"])("%s budget failure preserves history without applying changes", async (kind) => {
  const f = fixture(async function* (request) {
    yield { type: "text-delta", text: "Received so far" };
    if (kind === "text") yield { type: "text-delta", text: "x".repeat(512 * 1024) };
    if (kind === "tool") request.executeTool("huge", commandName, { ...commandInput, name: "x".repeat(256 * 1024) });
  });
  const text = kind === "context" ? "x".repeat(1024 * 1024) : "Keep this prompt";
  await f.runtime.submit({ text, connection });
  const state = f.runtime.getSnapshot();
  assert.equal(state.run.outcome, "failed");
  assert.equal(state.run.error, kind === "context" ? "context-limit" : "output-limit");
  assert.equal(state.messages[0].text, text);
  if (kind !== "context") assert.equal(state.messages[1].text, "Received so far");
  assert.equal(f.processor.historyLength, 0);
});

test("removing or pausing queued work during lease acquisition wins before dispatch", async () => {
  for (const action of ["remove", "pause"]) {
    const f = fixture(async function* () {
      yield { type: "text-delta", text: "Never" };
    });
    await f.runtime.enqueue({ text: "Queued", connection });
    const acquire = f.repository.acquire.bind(f.repository);
    const gate = deferred();
    let acquiring = false;
    f.repository.acquire = async (...args) => {
      acquiring = true;
      await gate.promise;
      return acquire(...args);
    };
    const resume = f.runtime.resumeQueue();
    await vi.waitFor(() => assert.equal(acquiring, true));
    if (action === "remove") await f.runtime.removeQueued(f.runtime.getSnapshot().queue.entries[0].id);
    else f.runtime.pauseQueue();
    gate.resolve();
    await resume;
    assert.equal(f.requests, 0);
  }
});