import assert from "node:assert/strict";
import { tool } from "ai";
import { test } from "vite-plus/test";
import { z } from "zod";
import {
  AI_PROVIDER_SETTINGS_STORAGE_KEY,
  createOpenAICompatibleChatModel,
  createAIModelingTools,
  executeAIModelingTool,
  loadAIProviderSettings,
  OpenAICompatibleConfigError,
  removeAIProviderCredential,
  saveAIProviderSettings,
  streamOpenAICompatibleChat,
  validateAIProviderSettings,
} from "./index.ts";
import { MODELING_COMMANDS, MODELING_QUERIES } from "@open-3d/model-core";

const emptyDocument = () => ({
  schemaVersion: 1,
  id: "document-test",
  name: "Test scene",
  activeSceneId: "scene-test",
  scenes: [{ id: "scene-test", name: "Scene", objectIds: [] }],
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

function streamingResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}

function toolCallResponse(id, name, argumentsValue) {
  return streamingResponse([
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${id}`,
                type: "function",
                function: { name, arguments: JSON.stringify(argumentsValue) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

test("validates OpenAI-compatible endpoint and model configuration", () => {
  for (const config of [
    { baseURL: "", modelId: "model" },
    { baseURL: "not a URL", modelId: "model" },
    { baseURL: "file:///tmp/model", modelId: "model" },
    { baseURL: "https://example.test/v1", modelId: " " },
  ]) {
    assert.throws(
      () => createOpenAICompatibleChatModel(config),
      (error) => error instanceof OpenAICompatibleConfigError,
    );
  }
});

test("validates required provider fields and makes API key optional", () => {
  const invalid = validateAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "not a URL",
    modelId: " ",
  });
  assert.equal(invalid.success, false);
  assert.equal(invalid.fieldErrors.baseURL, "Enter a valid absolute URL.");
  assert.equal(invalid.fieldErrors.modelId, "Enter a model identifier.");

  const valid = validateAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1/",
    modelId: " test-model ",
    apiKey: " ",
  });
  assert.equal(valid.success, true);
  assert.deepEqual(valid.data, {
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: undefined,
  });
  assert.doesNotThrow(() =>
    createOpenAICompatibleChatModel({
      baseURL: valid.data.baseURL,
      modelId: valid.data.modelId,
      apiKey: valid.data.apiKey,
    }),
  );
});

test("persists valid provider settings and rejects invalid settings without writing", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };

  const invalid = saveAIProviderSettings({ protocol: "openai-compatible", baseURL: "", modelId: "" }, storage);
  assert.equal(invalid.success, false);
  assert.equal(values.size, 0);

  const saved = saveAIProviderSettings(
    {
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      apiKey: "test-key",
    },
    storage,
  );
  assert.equal(saved.success, true);
  assert.equal(values.has(AI_PROVIDER_SETTINGS_STORAGE_KEY), true);
  assert.deepEqual(loadAIProviderSettings(storage), saved.data);
});

test("removes only the saved API credential and retains provider settings", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };

  saveAIProviderSettings(
    {
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      apiKey: "secret",
    },
    storage,
  );

  assert.equal(removeAIProviderCredential(storage), true);
  assert.equal(removeAIProviderCredential(storage), false);
  assert.deepEqual(loadAIProviderSettings(storage), {
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
});

test("streams OpenAI-compatible chat and sends registered tool JSON Schema", async () => {
  const requests = [];
  const fetchMock = async (input, init) => {
    requests.push({ url: String(input), init });
    return streamingResponse([
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Ready "},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"to model."},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };
  const result = streamOpenAICompatibleChat({
    config: {
      baseURL: "https://models.example.test/v1/",
      modelId: "test-model",
      apiKey: "test-secret",
      fetch: fetchMock,
    },
    messages: [{ role: "user", content: "What can you do?" }],
    tools: {
      getScene: tool({
        description: "Read the active scene hierarchy.",
        inputSchema: z.object({ sceneId: z.string() }),
      }),
    },
  });

  assert.equal(await result.text, "Ready to model.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://models.example.test/v1/chat/completions");
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer test-secret");
  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.tools[0].function.parameters, {
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
    properties: { sceneId: { type: "string" } },
    required: ["sceneId"],
    type: "object",
  });
});

test("continues through multiple tool rounds against the evolving preview document", async () => {
  const requests = [];
  const previewDocuments = [];
  const fetchMock = async (_input, init) => {
    const requestBody = JSON.parse(init.body);
    requests.push(requestBody);
    if (requests.length === 1) {
      return toolCallResponse("create", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Table top",
      });
    }
    if (requests.length === 2) {
      return toolCallResponse("inspect", "query_scene_getHierarchy", { limit: 20 });
    }
    return streamingResponse([
      `data: ${JSON.stringify({
        id: "chatcmpl-finish",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { content: "The table is ready for review." }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-finish",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const tools = createAIModelingTools(emptyDocument(), {
    onCommandProposal: (_request, previewDocument) => previewDocuments.push(previewDocument),
  });
  const result = streamOpenAICompatibleChat({
    config: {
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      fetch: fetchMock,
    },
    messages: [{ role: "user", content: "Build a table." }],
    tools,
  });

  assert.equal(await result.text, "The table is ready for review.");
  assert.equal(requests.length, 3);
  assert.equal(previewDocuments.length, 1);
  assert.equal(previewDocuments[0].objects[0].name, "Table top");
  const secondRoundMessages = requests[1].messages;
  assert.ok(secondRoundMessages.some((message) => message.role === "tool"));
  const hierarchyResult = requests[2].messages.find((message) => message.role === "tool");
  assert.ok(hierarchyResult);
  assert.match(hierarchyResult.content, /Table top/);
});

test("reconnects a failed tool follow-up without executing the completed command again", async () => {
  const requests = [];
  const previews = [];
  const result = streamOpenAICompatibleChat({
    config: {
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      fetch: async (_input, init) => {
        requests.push(init.body);
        if (requests.length === 1)
          return toolCallResponse("box", "command_scene_createPrimitive", { primitive: "box" });
        if (requests.length === 2) throw new TypeError("Failed to fetch");
        return streamingResponse([
          'data: {"id":"done","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}\n\n',
          'data: {"id":"done","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      },
    },
    messages: [{ role: "user", content: "Make a box" }],
    tools: createAIModelingTools(emptyDocument(), { onCommandProposal: (request) => previews.push(request) }),
    retry: { initialDelayMs: 0 },
  });
  assert.equal(await result.text, "Ready");
  assert.equal(requests.length, 3);
  assert.equal(requests[1], requests[2]);
  assert.equal(previews.length, 1);
});

test("passes cancellation through to the browser fetch request", async () => {
  const controller = new AbortController();
  let requestSignal;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const result = streamOpenAICompatibleChat({
    config: {
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      fetch: async (_input, init) => {
        requestSignal = init.signal;
        markRequestStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    },
    messages: [{ role: "user", content: "Make a box." }],
    abortSignal: controller.signal,
  });

  await requestStarted;
  controller.abort(new Error("Cancelled by test."));
  await assert.rejects(result.text, /Cancelled by test/);
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
});

test("registers every catalog command and bounded query as a model tool", () => {
  const tools = createAIModelingTools(emptyDocument());

  assert.equal(Object.keys(tools).length, MODELING_COMMANDS.length + MODELING_QUERIES.length);
  for (const { id } of MODELING_COMMANDS) assert.ok(tools[`command_${id.replaceAll(".", "_")}`]);
  for (const { id } of MODELING_QUERIES) assert.ok(tools[`query_${id.replaceAll(".", "_")}`]);
});

test("executes registered queries locally and returns serializable bounded data", () => {
  const document = emptyDocument();
  const before = structuredClone(document);

  assert.deepEqual(executeAIModelingTool(document, "query_scene_getHierarchy", { limit: 1 }), {
    kind: "query",
    queryId: "scene.getHierarchy",
    result: { sceneId: "scene-test", items: [], nextCursor: null },
  });
  assert.deepEqual(document, before);
});

test("validates command proposals locally without changing the document", () => {
  const document = emptyDocument();
  const before = structuredClone(document);
  const proposal = executeAIModelingTool(document, "command_scene_createPrimitive", {
    primitive: "box",
  });

  assert.deepEqual(proposal, {
    kind: "command-proposal",
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box" },
    eligible: true,
    requiresUserReview: true,
  });
  assert.deepEqual(document, before);
});

test("rejects unregistered tools, unknown operations, and invalid arguments locally", () => {
  const document = emptyDocument();

  assert.throws(
    () => executeAIModelingTool(document, "query_scene_unknown", {}),
    /is not registered in the modeling catalog/,
  );
  assert.throws(
    () => executeAIModelingTool(document, "command_scene_unknown", {}),
    /is not registered in the modeling catalog/,
  );
  assert.deepEqual(
    executeAIModelingTool(document, "query_operation_getEligibility", {
      commandId: "scene.unknownOperation",
      arguments: {},
    }),
    {
      kind: "query",
      queryId: "operation.getEligibility",
      result: {
        eligible: false,
        blockers: [
          {
            code: "unknown-command",
            message: 'Unknown modeling command "scene.unknownOperation".',
          },
        ],
      },
    },
  );
  assert.throws(
    () => executeAIModelingTool(document, "query_scene_getHierarchy", { limit: 1001 }),
    (error) => error.code === "invalid-arguments",
  );
  assert.throws(
    () =>
      executeAIModelingTool(document, "command_scene_createPrimitive", {
        primitive: "torus",
      }),
    (error) => error.code === "invalid-arguments",
  );
  assert.throws(
    () =>
      executeAIModelingTool(document, "command_object_rename", {
        objectId: "missing",
        name: "Renamed",
      }),
    (error) => error.code === "operation-ineligible",
  );
  assert.deepEqual(document, emptyDocument());
});