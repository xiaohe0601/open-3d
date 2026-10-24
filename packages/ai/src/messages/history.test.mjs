import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createModraSession, reduceModraSession } from "../runtime/index.ts";
import { buildSemanticHistory, describeApplicationOutcome } from "./history.ts";

const base = { generationId: "generation", scopeId: "scope", mutationVersion: 0 };
function transcript(decision, effect = "present") {
  let state = createModraSession("session", "scope");
  let sequence = 0;
  const send = (event) => {
    state = reduceModraSession(state, { sessionId: "session", runId: "run", sequence: ++sequence, ...event });
  };
  send({
    type: "run.started",
    taskId: "task",
    messageId: "assistant",
    mode: "build",
    approval: "request",
    base,
    input: {
      id: "user",
      text: "Make a box",
      assets: [{ assetId: "asset", name: "box.png", mediaType: "image/png", byteLength: 100 }],
    },
  });
  send({ type: "message.delta", text: "Preview a box" });
  send({
    type: "tool.updated",
    tool: {
      id: "call",
      providerCallId: "provider-call",
      name: "create",
      status: "completed",
      input: {},
      output: { kind: "command-proposal" },
      providerMetadata: { protocol: "gemini", value: { signature: "opaque" } },
    },
  });
  send({
    type: "changes.staged",
    id: "change",
    commands: [{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }],
  });
  send({ type: "run.finished", outcome: "completed" });
  if (decision)
    send({
      type: "review.decided",
      id: "change",
      decision,
      ...(decision === "applied" ? { appliedVersion: { ...base, mutationVersion: 1 } } : {}),
    });
  if (decision === "applied") send({ type: "effect.changed", id: "change", effect });
  return state;
}

test.each([
  [undefined, "unknown"],
  ["applied", "present"],
  ["rejected", "obsolete"],
  ["applied", "undone"],
  ["applied", "unknown"],
])("history distinguishes %s decisions with %s current effects without replay", (decision, effect) => {
  const state = transcript(decision, effect);
  const before = structuredClone(state);
  const history = buildSemanticHistory(state, "openai-compatible");
  assert.deepEqual(state, before);
  assert.deepEqual(
    history.map((message) => message.role),
    ["user", "assistant", "tool", "user"],
  );
  const call = history[1].content.find((part) => part.type === "tool-call");
  const result = history[2].content[0];
  assert.equal(call.id, result.id);
  assert.equal(call.metadata, undefined);
  assert.deepEqual(result.base, base);
  const outcome = history[3].content[0];
  assert.equal(outcome.decision, decision ?? "pending");
  assert.equal(outcome.effect, effect);
  assert.match(describeApplicationOutcome(outcome), /not a live scene commit/);
  assert.match(describeApplicationOutcome(outcome), /Do not replay/);
  assert.equal(history[0].content[1].asset.assetId, "asset");
  assert.equal(JSON.stringify(history).includes("data:image"), false);
  assert.equal(
    history.some((message) => message.content.some((part) => "commands" in part)),
    false,
  );
});

test("same-protocol opaque metadata survives; switching protocols rebuilds compatible envelopes", () => {
  const state = transcript("applied");
  const same = buildSemanticHistory(state, "gemini");
  assert.deepEqual(same[1].content.find((part) => part.type === "tool-call").metadata, { signature: "opaque" });
  const other = buildSemanticHistory(state, "anthropic-messages");
  assert.equal(other[1].content.find((part) => part.type === "tool-call").metadata, undefined);
  assert.equal(other[1].content.find((part) => part.type === "tool-call").id, "call");
});

test("an independent prompt sees undone historical work as undone, not as a fresh command", () => {
  let state = transcript("applied", "undone");
  // End the old task instead of continuing it, then submit a different user intent.
  state = reduceModraSession(state, {
    sessionId: "session",
    runId: "run",
    sequence: state.lastSequence + 1,
    type: "run.finished",
    outcome: "completed",
  });
  state = reduceModraSession(state, {
    sessionId: "session",
    runId: "independent-run",
    sequence: state.lastSequence + 1,
    type: "run.started",
    taskId: "independent-task",
    messageId: "new-assistant",
    mode: "build",
    approval: "request",
    base: { ...base, mutationVersion: 2 },
    input: { id: "new-user", text: "What remains in the scene?", assets: [] },
  });
  const history = buildSemanticHistory(state, "anthropic-messages");
  assert.equal(history.at(-1).content[0].text, "What remains in the scene?");
  const outcome = history.flatMap((message) => message.content).find((part) => part.type === "application-outcome");
  assert.equal(outcome.decision, "applied");
  assert.equal(outcome.effect, "undone");
  assert.equal(history.filter((message) => message.role === "tool").length, 1);
  assert.equal(state.runs[0].outcome, "completed");
});

test.each(["preparing", "running", "failed", "cancelled", "completed"])(
  "incomplete %s tools use semantic interruption, never orphan call/result envelopes",
  (status) => {
    const state = transcript();
    const modified = {
      ...state,
      messages: state.messages.map((message) =>
        message.role === "assistant"
          ? { ...message, toolCalls: [{ id: "unfinished", name: "query", status, input: { limit: 1 } }] }
          : message,
      ),
    };
    const history = buildSemanticHistory(modified, "openai-compatible");
    assert.equal(
      history.some((message) => message.role === "tool"),
      false,
    );
    assert.equal(
      history[1].content.some((part) => part.type === "tool-call"),
      false,
    );
    assert.deepEqual(history[1].content.at(-1), {
      type: "interrupted-tool",
      id: "unfinished",
      name: "query",
      status,
      input: { limit: 1 },
    });
  },
);