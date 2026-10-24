import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { ModelingCommandProcessor, createCoreCommandHandlers } from "@open-3d/model-core";
import { createModraProvider } from "../providers/native-protocols.ts";
import { createModraTransport } from "../transport/gateway.ts";
import { createModraSession, createMemorySessionRepository, ModraRuntime, sameHostVersion } from "./index.ts";
import { chatToolCallResponse, chatTextResponse } from "../../../../tests/fixtures/ai/chat-completions.ts";
import { responsesFixture, anthropicFixture, geminiFixture } from "../../../../tests/fixtures/ai/native-protocols.ts";

const protocols = ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"];
const cases = protocols.flatMap((protocol) => ["direct", "official", "self-hosted"].map((route) => [protocol, route]));
const command = {
  id: "create",
  name: "command_scene_createPrimitive",
  input: { primitive: "box", name: "Matrix box" },
};
function response(protocol, call) {
  if (protocol === "openai-compatible")
    return call ? chatToolCallResponse(call.id, call.name, call.input) : chatTextResponse("end", "Ready");
  return { "openai-responses": responsesFixture, "anthropic-messages": anthropicFixture, gemini: geminiFixture }[
    protocol
  ](call);
}
function setup(protocol, route, outcome) {
  let serial = 0;
  let requests = 0;
  let grantCalls = 0;
  const bodies = [];
  const config = {
    protocol,
    route,
    baseURL: "https://models.example/v1",
    modelId: "test-model",
    apiKey: "sentinel-key",
    ...(route === "self-hosted" ? { gatewayURL: "https://gateway.example", gatewayToken: "sentinel-gateway" } : {}),
  };
  const transport = createModraTransport({
    settings: () => config,
    officialURL: "https://official.example",
    acquireGrant: async () => {
      grantCalls++;
      return { token: "sentinel-grant", expiresAt: Date.now() + 300000 };
    },
    fetch: async (url, init) => {
      const target = url instanceof Request ? url.url : url.toString();
      if (target.endsWith("/capabilities")) {
        assert.equal(new Headers(init.headers).get("authorization"), null);
        return Response.json({
          version: 1,
          enabled: true,
          protocols,
          auth: route === "official" ? "turnstile-grant" : "deployment-token",
          limits: { requestBytes: 50331648, idleMs: 60000, totalMs: 600000, concurrent: 2 },
        });
      }
      requests++;
      assert.equal(target.includes("sentinel"), false);
      if (route !== "direct") {
        assert.equal(new Headers(init.headers).get("X-Open-3D-Protocol"), protocol);
        assert.equal(
          new Headers(init.headers).get("X-Open-3D-Gateway-Token"),
          route === "official" ? "sentinel-grant" : "sentinel-gateway",
        );
      }
      assert.equal(typeof init.body, "string");
      bodies.push(init.body);
      if (outcome === "failure") return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
      if (outcome === "cancel")
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          }),
        );
      return response(protocol, requests === 1 ? command : undefined);
    },
  });
  const version = { generationId: "generation", scopeId: "scope", mutationVersion: 0 };
  const processor = new ModelingCommandProcessor(
    {
      schemaVersion: 1,
      id: "doc",
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
    },
    { handlers: createCoreCommandHandlers() },
  );
  const commits = new Set();
  const host = {
    snapshot: () => ({ version: { ...version }, document: processor.getDocumentSnapshot(), transient: false }),
    preview() {},
    commit(id, expected, commands) {
      assert.ok(sameHostVersion(expected, version));
      assert.equal(commits.has(id), false);
      processor.executeGroup(commands);
      commits.add(id);
      version.mutationVersion++;
      return host.snapshot();
    },
  };
  const runtime = new ModraRuntime(createModraSession("session", "scope"), {
    host,
    transport,
    repository: createMemorySessionRepository("owner", Date.now),
    clock: { now: Date.now, id: (kind) => `${kind}-${++serial}` },
    credentials: { resolve: () => ({ revision: "one", apiKey: config.apiKey }), isCurrent: () => true },
    provider: createModraProvider({
      model: () => config,
      image: () => "data:image/png;base64,AQID",
      retryTiming: { initialDelayMs: 0 },
    }),
  });
  return { runtime, processor, commits, bodies, requests: () => requests, grants: () => grantCalls };
}

test.each(cases)(
  "%s / %s: images, native tools, review, continuation and duplicate-approval guard",
  async (protocol, route) => {
    const f = setup(protocol, route, "success");
    await f.runtime.submit({
      text: "Build this image",
      assets: [{ assetId: "image", name: "ref.png", mediaType: "image/png", byteLength: 3 }],
      connection: { providerId: "test", protocol, route },
    });
    assert.equal(f.runtime.getSnapshot().run.phase, "awaiting-review");
    assert.equal(f.processor.historyLength, 0);
    const change = f.runtime.getSnapshot().changeSets[0];
    assert.match(f.bodies[0], /AQID/);
    await f.runtime.accept(change.id);
    await f.runtime.accept(change.id);
    assert.equal(f.commits.size, 1);
    assert.equal(f.processor.getDocumentSnapshot().objects[0].name, "Matrix box");
    assert.equal(f.requests(), 3);
    assert.equal(f.grants(), route === "official" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(f.runtime.getSnapshot()), /sentinel-key|sentinel-gateway|sentinel-grant/);
  },
);
for (const outcome of ["failure", "cancel"])
  test.each(cases)(`%s / %s: ${outcome} preserves scene and never applies work`, async (protocol, route) => {
    const f = setup(protocol, route, outcome);
    const work = f.runtime.submit({ text: "Keep instructions", connection: { providerId: "test", protocol, route } });
    if (outcome === "cancel") {
      await vi.waitFor(() => assert.equal(f.requests(), 1));
      f.runtime.cancel();
    }
    await work;
    assert.equal(f.runtime.getSnapshot().run.outcome, outcome === "cancel" ? "cancelled" : "failed");
    assert.equal(f.runtime.getSnapshot().messages[0].text, "Keep instructions");
    assert.equal(f.commits.size, 0);
    assert.equal(f.processor.historyLength, 0);
    assert.equal(f.requests(), 1);
  });