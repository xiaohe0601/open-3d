import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  buildSemanticHistory,
  compactionCandidate,
  contextWindowTokens,
  contextWindowUsage,
  createModraSession,
  estimateContextTokens,
  estimateToolContextTokens,
} from "./index.ts";

test("context uses configured token capacity, image overhead and output reserve, not cumulative billing usage", () => {
  assert.equal(contextWindowTokens(), 32768);
  assert.equal(contextWindowTokens(128000), 128000);
  for (const value of [0, -1, NaN, Infinity, 123.5, 100]) assert.equal(contextWindowTokens(value), 32768);
  const history = [{ id: "u", role: "user", content: [{ type: "text", text: "约束" }] }];
  const plain = estimateContextTokens(history);
  history[0].content.push({ type: "image", asset: { assetId: "asset" } });
  assert.equal(estimateContextTokens(history), plain + 4096);
  const usage = contextWindowUsage(history, 65536, 500);
  assert.equal(usage.windowTokens, 65536);
  assert.equal(usage.inputTokens, plain + 4096 + estimateToolContextTokens("build") + 500);
  assert.equal(usage.reservedTokens, 4096);
  assert.ok(estimateToolContextTokens("build") > estimateToolContextTokens("plan"));
});

test("checkpoints keep tool pairs and current tasks whole and refresh historical effects from live state", () => {
  const base = { generationId: "g", scopeId: "s", mutationVersion: 0 };
  const message = (id, taskId, role, extra = {}) => ({
    id,
    taskId,
    runId: id,
    role,
    base,
    text: id,
    assets: [],
    toolCalls: [],
    ...extra,
  });
  const state = {
    ...createModraSession("session", "s"),
    messages: [
      message("u1", "t1", "user"),
      message("a1", "t1", "assistant", { changeSetId: "c1" }),
      message("continuation", "t1", "assistant"),
      message("u2", "t2", "user"),
      message("a2", "t2", "assistant", {
        toolCalls: [{ id: "tool", name: "query", status: "completed", input: {}, output: {} }],
      }),
      message("active", "t2", "assistant"),
    ],
    run: { taskId: "t2" },
    changeSets: [{ id: "c1", messageId: "a1", status: "applied", effect: "undone", interrupted: false, base }],
  };
  const candidate = compactionCandidate(state, "gemini");
  assert.equal(candidate.throughMessageId, "continuation");
  state.contextCheckpoint = {
    throughMessageId: candidate.throughMessageId,
    summary: "Box proposed; not current scene truth.",
    compactions: 1,
  };
  const history = buildSemanticHistory(state, "gemini");
  assert.ok(history[0].content[0].text.includes('"effect":"undone"'));
  assert.ok(history[0].content[0].text.includes("never replay"));
  assert.equal(history.find((item) => item.id === "a2").content.at(-1).type, "tool-call");
  assert.equal(history.find((item) => item.id === "a2:results").content[0].type, "tool-result");
  state.changeSets[0].effect = "obsolete";
  assert.ok(buildSemanticHistory(state, "gemini")[0].content[0].text.includes('"effect":"obsolete"'));
  assert.equal(compactionCandidate(state, "gemini"), null);
  assert.equal(state.messages.length, 6);
});

test("unanswered failed inputs and their images are not compressed just because the user resends them", () => {
  const state = {
    ...createModraSession("session", "s"),
    run: { taskId: "retry" },
    messages: [
      { id: "first", taskId: "first", role: "user", text: "Build this", assets: [{ assetId: "image" }], toolCalls: [] },
      { id: "retry", taskId: "retry", role: "user", text: "Build this", assets: [{ assetId: "image" }], toolCalls: [] },
    ],
  };
  assert.equal(compactionCandidate(state, "openai-compatible"), null);
  assert.equal(state.messages[0].assets.length, 1);
});