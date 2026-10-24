import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { generateSessionTitle } from "./session-title.ts";
import { shortSessionTitle, limitSessionTitle } from "../messages/session-title.ts";
import { chatTextResponse } from "../../../../tests/fixtures/ai/chat-completions.ts";
import { responsesFixture, anthropicFixture, geminiFixture } from "../../../../tests/fixtures/ai/native-protocols.ts";

test("short titles count graphemes and normalize whitespace without splitting emoji", () => {
  assert.equal(shortSessionTitle("  Build a\nreading lamp  "), "Build a re");
  assert.equal(limitSessionTitle("My "), "My ");
  assert.equal(shortSessionTitle("👩‍💻".repeat(12)), "👩‍💻".repeat(10));
  assert.equal(shortSessionTitle("台灯".repeat(12)), "台灯".repeat(5));
});

/** @type {Array<[import("../settings.ts").AIProtocol, () => Response]>} */
const protocols = [
  ["openai-compatible", () => chatTextResponse("title", '"Reading lamp"')],
  ["openai-responses", () => responsesFixture(undefined, '"Reading lamp"')],
  ["anthropic-messages", () => anthropicFixture(undefined, '"Reading lamp"')],
  ["gemini", () => geminiFixture(undefined, '"Reading lamp"')],
];
for (const [protocol, response] of protocols) {
  test(`${protocol} generates bounded titles without tools, images, or scene context`, async () => {
    let body;
    const title = await generateSessionTitle({
      settings: { protocol, route: "direct", baseURL: "https://models.example/v1", modelId: "test-model" },
      signal: new AbortController().signal,
      prompt: "Build a reading lamp",
      reply: "The lamp is ready.",
      fetch: async (_input, init) => {
        body = JSON.parse(init.body);
        return response();
      },
    });
    assert.equal(title, "Reading la");
    assert.equal(body.tools, undefined);
    assert.ok(JSON.stringify(body).includes("Build a reading lamp"));
    assert.ok(!JSON.stringify(body).includes("data:image"));
    if (protocol === "openai-responses") assert.equal(body.store, false);
  });
}

test("title generation rejects connection failures and respects cancellation", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    generateSessionTitle({
      settings: {
        protocol: "openai-compatible",
        route: "direct",
        baseURL: "https://models.example/v1",
        modelId: "test-model",
      },
      prompt: "Lamp",
      reply: "Ready",
      signal: abort.signal,
      fetch: async () => {
        throw new Error("Must not dispatch");
      },
    }),
  );
});

test("oversized title output is rejected instead of being accumulated without a bound", async () => {
  await assert.rejects(
    generateSessionTitle({
      settings: {
        protocol: "openai-compatible",
        route: "direct",
        baseURL: "https://models.example/v1",
        modelId: "test-model",
      },
      prompt: "Lamp",
      reply: "Ready",
      signal: new AbortController().signal,
      fetch: async () => chatTextResponse("title", "x".repeat(4097)),
    }),
    /too large/,
  );
});