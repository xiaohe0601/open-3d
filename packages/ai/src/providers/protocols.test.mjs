import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createModraProvider, createChatCompletionsProvider } from "../index.ts";
import { classifyModraProviderError } from "../runtime/errors.ts";
import { responsesFixture, anthropicFixture, geminiFixture } from "../../../../tests/fixtures/ai/native-protocols.ts";
import { chatToolCallResponse, chatTextResponse } from "../../../../tests/fixtures/ai/chat-completions.ts";
import { assertSDKContextWindow } from "./context-budget.ts";

const protocols = ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"];
const query = "query_scene_getHierarchy";
const command = "command_scene_createPrimitive";
const args = { primitive: "box", name: "Reviewed box" };
const image = { assetId: "image", name: "reference.png", mediaType: "image/png", byteLength: 3 };
const base = { generationId: "g", scopeId: "s", mutationVersion: 0 };
test("per-round context estimates count images by image overhead, not encoded file bytes", () => {
  const f = fixture("openai-compatible");
  assert.doesNotThrow(() =>
    assertSDKContextWindow(f.request, [
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array(5 * 1024 * 1024) }] },
    ]),
  );
  assert.throws(() => assertSDKContextWindow(f.request, [{ role: "assistant", content: "large text".repeat(20000) }]), {
    code: "context-limit",
  });
});
const response = (protocol, call) =>
  protocol === "openai-compatible"
    ? call
      ? chatToolCallResponse(call.id, call.name, call.input)
      : chatTextResponse("end", "Ready for review.")
    : protocol === "openai-responses"
      ? responsesFixture(call)
      : protocol === "anthropic-messages"
        ? anthropicFixture(call)
        : geminiFixture(call);

function fixture(protocol, fetchOverride) {
  const requests = [];
  const executed = [];
  const provider = createModraProvider({
    model: () => ({ baseURL: "https://models.example/v1", modelId: "test-model" }),
    image: () => "data:image/png;base64,AQID",
    retryTiming: { initialDelayMs: 0 },
  });
  const request = {
    connection: { providerId: "test", protocol, route: "direct" },
    credentials: { revision: "1", apiKey: "sentinel-key" },
    mode: "build",
    scene: {
      version: base,
      document: {
        schemaVersion: 1,
        id: "document",
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
      transient: false,
    },
    signal: new AbortController().signal,
    assertActive() {},
    history: [
      {
        id: "u",
        role: "user",
        content: [
          { type: "text", text: "Build this" },
          { type: "image", asset: image },
          { type: "image", asset: { ...image, assetId: "second" } },
        ],
      },
    ],
    executeTool(id, name, input) {
      executed.push({ id, name, input });
      return name === query ? { sceneId: "s", items: [] } : { kind: "command-proposal", eligible: true };
    },
    transport: {
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          headers: new Headers(init.headers),
          body: JSON.parse(init.body),
          signal: init.signal,
        });
        if (fetchOverride) return fetchOverride(url, init, requests.length);
        return response(
          protocol,
          requests.length === 1
            ? { id: "query", name: query, input: { limit: 10 } }
            : requests.length === 2
              ? { id: "command", name: command, input: args }
              : undefined,
        );
      },
    },
  };
  return { provider, request, requests, executed };
}

test("large compaction inputs are summarized in bounded sequential chunks without losing Unicode or earlier summaries", async () => {
  const f = fixture("openai-compatible", () => chatTextResponse("summary", "Previous goals and constraints retained."));
  f.request.connection.configuration = {
    baseURL: "https://models.example/v1",
    modelId: "test-model",
    contextWindowTokens: 16384,
  };
  f.request.history = [{ id: "large", role: "user", content: [{ type: "text", text: '🧊建模\\"'.repeat(6000) }] }];
  for await (const _chunk of f.provider.compact(f.request)) {
    /* Drain the summary. */
  }
  assert.ok(f.requests.length > 1);
  const payloads = f.requests.map((request) => {
    const content = request.body.messages.find((message) => message.role === "user").content;
    assert.ok(new TextEncoder().encode(JSON.stringify(content)).byteLength <= (16384 - 8192) * 3);
    return JSON.parse(content);
  });
  assert.equal(payloads.map((payload) => payload.nextHistoryChunk).join(""), JSON.stringify(f.request.history));
  assert.equal(payloads[0].previousSummary, "");
  assert.ok(
    payloads.slice(1).every((payload) => payload.previousSummary === "Previous goals and constraints retained."),
  );
  assert.equal(f.executed.length, 0);
});

for (const protocol of protocols) {
  test(`${protocol}: compaction is text-only, bounded and tool-free through the configured guarded transport`, async () => {
    const f = fixture(protocol, () => response(protocol));
    const text = [];
    for await (const chunk of f.provider.compact(f.request)) text.push(chunk);
    assert.ok(text.join("").trim());
    assert.equal(f.executed.length, 0);
    assert.equal(f.requests.length, 1);
    const body = f.requests[0].body;
    assert.equal(body.tools, undefined);
    assert.ok(!JSON.stringify(body).includes("data:image"));
    assert.ok(!JSON.stringify(body).includes("Historical queries and tool results are observations"));
    assert.ok(JSON.stringify(body).includes("Compact this modeling conversation"));
    if (protocol === "openai-responses") assert.equal(body.store, false);
  });
  test(`${protocol}: native multimodal query/proposal/text round trip with one retry owner`, async () => {
    const f = fixture(protocol);
    const parts = [];
    for await (const part of f.provider.stream(f.request)) parts.push(part);
    assert.deepEqual(
      parts.filter((part) => part.type === "error"),
      [],
    );
    assert.equal(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
        .join(""),
      "Ready for review.",
    );
    assert.equal(parts.filter((part) => part.type === "step-start").length, 3);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(
      f.executed.map((call) => [call.name, call.input]),
      [
        [query, { limit: 10 }],
        [command, args],
      ],
    );
    const { url, headers, body } = f.requests[0];
    assert.equal(url.includes("sentinel-key"), false);
    assert.match(JSON.stringify(body), /AQID/);
    if (protocol === "openai-compatible") {
      assert.equal(url, "https://models.example/v1/chat/completions");
      assert.equal(headers.get("authorization"), "Bearer sentinel-key");
      assert.equal(
        body.messages.find((message) => message.role === "user").content.filter((part) => part.type === "image_url")
          .length,
        2,
      );
      assert.ok(f.requests[1].body.messages.some((message) => message.role === "tool"));
    } else if (protocol === "openai-responses") {
      assert.equal(url, "https://models.example/v1/responses");
      for (const entry of f.requests) {
        assert.equal(entry.body.store, false);
        assert.equal(entry.body.previous_response_id, undefined);
        assert.equal(entry.body.conversation, undefined);
      }
      assert.equal(
        body.input.find((message) => message.role === "user").content.filter((part) => part.type === "input_image")
          .length,
        2,
      );
      assert.ok(f.requests[1].body.input.some((item) => item.type === "function_call_output"));
    } else if (protocol === "anthropic-messages") {
      assert.equal(url, "https://models.example/v1/messages");
      assert.equal(headers.get("x-api-key"), "sentinel-key");
      assert.ok(headers.get("anthropic-version"));
      assert.equal(body.messages[0].content.filter((part) => part.type === "image").length, 2);
      assert.match(JSON.stringify(f.requests[1].body), /tool_result/);
    } else {
      assert.equal(url, "https://models.example/v1/models/test-model:streamGenerateContent?alt=sse");
      assert.equal(headers.get("x-goog-api-key"), "sentinel-key");
      assert.equal(body.contents[0].parts.filter((part) => part.inlineData).length, 2);
      assert.match(JSON.stringify(f.requests[1].body), /opaque-signature/);
      assert.ok(
        parts.some(
          (part) => part.type === "tool-metadata" && part.metadata.google?.thoughtSignature === "opaque-signature",
        ),
      );
    }
    assert.ok(parts.some((part) => part.type === "usage"));
  });

  test(`${protocol}: local application outcomes and paired historical calls never execute again`, async () => {
    const f = fixture(protocol, () => response(protocol));
    f.request.history = [
      {
        id: "old",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "old-call",
            name: command,
            input: args,
            ...(protocol === "gemini" ? { metadata: { google: { thoughtSignature: "historical-signature" } } } : {}),
          },
        ],
      },
      {
        id: "result",
        role: "tool",
        content: [{ type: "tool-result", id: "old-call", name: command, output: { eligible: true }, base }],
      },
      {
        id: "outcome",
        role: "user",
        content: [
          {
            type: "application-outcome",
            id: "changes",
            decision: "applied",
            effect: "undone",
            interrupted: false,
            base,
          },
        ],
      },
    ];
    for await (const part of f.provider.stream(f.request)) assert.notEqual(part.type, "error");
    assert.equal(f.executed.length, 0);
    assert.match(JSON.stringify(f.requests[0].body), /historical decision=applied; current scene effect=undone/);
    if (protocol === "gemini") assert.match(JSON.stringify(f.requests[0].body), /historical-signature/);
  });

  test(`${protocol}: authentication failure is classified and not retried`, async () => {
    const f = fixture(
      protocol,
      () =>
        new Response(JSON.stringify({ error: { message: "Denied", type: "authentication_error" } }), { status: 401 }),
    );
    const parts = [];
    for await (const part of f.provider.stream(f.request)) parts.push(part);
    const error = parts.find((part) => part.type === "error");
    assert.ok(error);
    assert.equal(classifyModraProviderError(error.error), "auth");
    assert.equal(f.requests.length, 1);
  });

  test(`${protocol}: cancellation reaches fetch without a retry or a tool call`, async () => {
    const abort = new AbortController();
    const f = fixture(protocol, async (_url, init) => {
      abort.abort();
      assert.equal(init.signal.aborted, true);
      throw new DOMException("Cancelled", "AbortError");
    });
    f.request.signal = abort.signal;
    for await (const _part of f.provider.stream(f.request)) {
      /* Drain terminal activity. */
    }
    assert.equal(f.requests.length, 1);
    assert.equal(f.executed.length, 0);
  });
}

test("Chat Completions compatibility adapter remains a public entry point", () => {
  assert.equal(typeof createChatCompletionsProvider, "function");
});
test("declared text-only/tool-less models block before resolving assets or dispatching", async () => {
  for (const modelId of ["gpt-3.5-turbo", "gpt-3.5-turbo-instruct"]) {
    const f = fixture("openai-compatible");
    const provider = createModraProvider({
      model: () => ({ baseURL: "https://models.example/v1", modelId }),
      image: () => {
        throw new Error("Must not resolve an unsupported asset");
      },
    });
    await assert.rejects(async () => {
      for await (const _part of provider.stream(f.request)) {
      }
    }, /does not support/);
    assert.equal(f.requests.length, 0);
  }
});

for (const protocol of protocols) {
  test(`${protocol}: transient retry reuses one follow-up body without replaying completed tools`, async () => {
    const f = fixture(protocol, (_url, _init, round) => {
      if (round === 1) return response(protocol, { id: "command", name: command, input: args });
      if (round === 2) throw new TypeError("Failed to fetch");
      return response(protocol);
    });
    const parts = [];
    for await (const part of f.provider.stream(f.request)) parts.push(part);
    assert.equal(f.executed.length, 1);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.requests[1].body, f.requests[2].body);
    assert.ok(parts.some((part) => part.type === "retry" && part.attempt === 1));
    assert.equal(
      parts.some((part) => part.type === "error"),
      false,
    );
  });

  test(`${protocol}: consumed partial streams are not replayed`, async () => {
    let fail;
    const responseStream = new ReadableStream({
      start(controller) {
        fail = () => controller.error(new TypeError("Lost connection"));
      },
    });
    const f = fixture(protocol, () => {
      queueMicrotask(fail);
      return new Response(responseStream, { headers: { "content-type": "text/event-stream" } });
    });
    const parts = [];
    for await (const part of f.provider.stream(f.request)) parts.push(part);
    assert.equal(f.requests.length, 1);
    assert.equal(f.executed.length, 0);
    assert.ok(parts.some((part) => part.type === "error"));
    assert.equal(
      parts.some((part) => part.type === "retry"),
      false,
    );
  });
}