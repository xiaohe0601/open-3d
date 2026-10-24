import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createModraSession, reduceModraSession, sameHostVersion } from "./index.ts";

const base = { generationId: "workspace-1", scopeId: "scope-1", mutationVersion: 2 };
const applied = { ...base, mutationVersion: 3 };
const commands = [{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }];

function fixture({ mode = "build", approval = "request" } = {}) {
  let state = createModraSession("session-1", base.scopeId);
  let sequence = 0;
  function send(event) {
    state = reduceModraSession(state, { sessionId: state.id, runId: "run-1", sequence: ++sequence, ...event });
    return state;
  }
  send({
    type: "run.started",
    taskId: "task-1",
    messageId: "assistant-1",
    input: { id: "user-1", text: "Build a box", assets: [] },
    mode,
    approval,
    base,
  });
  return {
    get state() {
      return state;
    },
    send,
  };
}

test("neutral run lifecycle keeps string identities, sequence, policy snapshot and immutable payloads", () => {
  const f = fixture();
  assert.equal(f.state.run.phase, "connecting");
  assert.equal(f.state.run.approval, "request");
  assert.deepEqual(
    f.state.messages.map((message) => message.id),
    ["user-1", "assistant-1"],
  );
  const previous = f.state;
  f.send({ type: "run.retrying", retry: { attempt: 1, maxRetries: 5, delayMs: 1000 } });
  assert.equal(f.state.run.phase, "retrying");
  f.send({ type: "message.delta", text: "A box" });
  assert.equal(f.state.run.retry, undefined);
  assert.equal(f.state.run.phase, "streaming");
  assert.equal(previous.messages[1].text, "");
  const payload = structuredClone(commands);
  f.send({ type: "changes.staged", id: "change-1", commands: payload });
  payload[0].arguments.primitive = "cone";
  assert.equal(f.state.changeSets[0].commands[0].arguments.primitive, "box");
  f.send({ type: "run.finished", outcome: "completed" });
  assert.equal(f.state.run.phase, "awaiting-review");
  assert.equal(f.state.changeSets[0].status, "pending");
  assert.equal(f.state.changeSets[0].effect, "unknown");
  f.send({ type: "review.decided", id: "change-1", decision: "applied", appliedVersion: applied });
  assert.equal(f.state.run.phase, "continuing");
  assert.equal(f.state.changeSets[0].status, "applied");
  assert.equal(f.state.changeSets[0].effect, "present");
  f.send({
    type: "run.started",
    runId: "run-2",
    taskId: "task-1",
    messageId: "assistant-2",
    mode: "build",
    approval: "request",
    base: applied,
  });
  assert.equal(f.state.run.id, "run-2");
  f.send({ type: "message.delta", runId: "run-2", text: "Done" });
  f.send({ type: "run.finished", runId: "run-2", outcome: "completed" });
  assert.equal(f.state.run.phase, "completed");
  f.send({ type: "effect.changed", id: "change-1", effect: "undone" });
  assert.equal(f.state.changeSets[0].status, "applied");
  assert.equal(f.state.changeSets[0].effect, "undone");
});

test.each(["request", "auto"])(
  "failed %s work retains only reviewable partial batches; Keep never continues",
  (approval) => {
    const f = fixture({ approval });
    f.send({ type: "changes.staged", id: "change-1", commands });
    f.send({ type: "tool.updated", tool: { id: "tool-1", name: "create", status: "running" } });
    f.send({ type: "run.finished", outcome: "failed", error: "network" });
    assert.equal(f.state.run.phase, "awaiting-review");
    assert.equal(f.state.run.outcome, "failed");
    assert.equal(f.state.messages[1].toolCalls[0].status, "failed");
    assert.equal(f.state.changeSets[0].interrupted, true);
    f.send({ type: "review.decided", id: "change-1", decision: "applied", appliedVersion: applied });
    assert.equal(f.state.run.phase, "failed");
    const previous = f.state;
    assert.equal(
      f.send({ type: "review.decided", id: "change-1", decision: "applied", appliedVersion: applied }),
      previous,
    );
  },
);

test.each(["cancelled", "stale"])("%s discards unconfirmed proposals and ignores late callbacks", (outcome) => {
  const f = fixture();
  f.send({ type: "message.delta", text: "Partial response" });
  f.send({ type: "tool.updated", tool: { id: "tool-1", name: "create", status: "preparing" } });
  f.send({ type: "changes.staged", id: "change-1", commands });
  if (outcome === "stale") f.send({ type: "host.invalidated" });
  else f.send({ type: "run.finished", outcome });
  assert.equal(f.state.run.phase, outcome);
  assert.equal(f.state.messages[1].text, "Partial response");
  assert.equal(f.state.messages[1].toolCalls[0].status, "cancelled");
  assert.equal(f.state.changeSets[0].status, outcome === "stale" ? "stale" : "rejected");
  const previous = f.state;
  for (const event of [
    { type: "message.delta", text: "late" },
    { type: "changes.staged", id: "change-1", commands },
    { type: "tool.updated", tool: { id: "tool-1", name: "create", status: "completed", output: "late" } },
    { type: "run.finished", outcome: "completed" },
    { type: "review.decided", id: "change-1", decision: "applied", appliedVersion: applied },
  ])
    assert.equal(f.send(event), previous);
});

test("out-of-order, cross-session and superseded events cannot poison sequence or resurrect a run", () => {
  const f = fixture();
  const initial = f.state;
  for (const event of [
    { type: "message.delta", text: "wrong session", sessionId: "other", sequence: 900 },
    { type: "message.delta", text: "wrong run", runId: "other", sequence: 900 },
    { type: "message.delta", text: "old sequence", sequence: initial.lastSequence },
    { type: "message.delta", text: "invalid sequence", sequence: Number.NaN },
    { type: "review.decided", id: "unknown", decision: "applied", appliedVersion: applied },
  ])
    assert.equal(f.send(event), initial);
  f.send({ type: "message.delta", text: "valid" });
  f.send({ type: "run.finished", outcome: "completed" });
  f.send({
    type: "run.started",
    runId: "run-2",
    taskId: "task-2",
    messageId: "assistant-2",
    input: { id: "user-2", text: "next", assets: [] },
    mode: "plan",
    approval: "auto",
    base,
  });
  const next = f.state;
  assert.equal(f.send({ type: "message.delta", text: "late", runId: "run-1", sequence: 999 }), next);
  assert.equal(f.state.messages.at(-1).text, "");
});

test("a run cannot start over unresolved review or reuse message, run and change identities", () => {
  const f = fixture();
  const start = {
    type: "run.started",
    taskId: "task-2",
    runId: "run-2",
    messageId: "assistant-2",
    input: { id: "user-2", text: "next", assets: [] },
    mode: "build",
    approval: "auto",
    base,
  };
  let previous = f.state;
  assert.equal(f.send(start), previous);
  f.send({ type: "changes.staged", id: "change-1", commands });
  f.send({ type: "run.finished", outcome: "completed" });
  previous = f.state;
  assert.equal(f.send(start), previous);
  assert.equal(f.send({ type: "review.decided", id: "change-1", decision: "applied", appliedVersion: base }), previous);
  assert.equal(
    f.send({
      type: "review.decided",
      id: "change-1",
      decision: "applied",
      appliedVersion: { ...applied, generationId: "replacement" },
    }),
    previous,
  );
  f.send({ type: "review.decided", id: "change-1", decision: "rejected" });
  previous = f.state;
  assert.equal(f.send({ ...start, messageId: "user-1" }), previous);
  assert.equal(f.send({ ...start, runId: "run-1" }), previous);
  assert.equal(f.send({ ...start, input: { id: "assistant-1", text: "bad", assets: [] } }), previous);
  f.send(start);
  previous = f.state;
  assert.equal(f.send({ type: "changes.staged", runId: "run-2", id: "change-1", commands }), previous);
});

test("Plan cannot stage mutations even with Auto-approve; terminal tools never spin again", () => {
  const f = fixture({ mode: "plan", approval: "auto" });
  const initial = f.state;
  assert.equal(f.send({ type: "changes.staged", id: "change-1", commands }), initial);
  f.send({ type: "tool.updated", tool: { id: "tool-1", name: "query", status: "completed", input: {}, output: {} } });
  const completed = f.state;
  assert.equal(f.send({ type: "tool.updated", tool: { id: "tool-1", name: "query", status: "running" } }), completed);
  f.send({ type: "run.finished", outcome: "completed" });
  assert.equal(f.state.run.phase, "completed");
  assert.equal(f.state.messages[1].toolCalls[0].status, "completed");
});

test.each(["failed", "cancelled"])("empty %s replies disappear but tool-only replies remain", (outcome) => {
  const f = fixture();
  f.send({ type: "message.delta", text: " \n " });
  f.send({ type: "run.finished", outcome });
  assert.deepEqual(
    f.state.messages.map((message) => message.role),
    ["user"],
  );
  const toolOnly = fixture();
  toolOnly.send({ type: "tool.updated", tool: { id: "tool-1", name: "query", status: "failed" } });
  toolOnly.send({ type: "run.finished", outcome });
  assert.equal(toolOnly.state.messages.length, 2);
});

test("host equality includes scope and generation independently of document identity", () => {
  assert.equal(sameHostVersion(base, { ...base }), true);
  assert.equal(sameHostVersion(base, { ...base, scopeId: "new-scope" }), false);
  assert.equal(sameHostVersion(base, { ...base, generationId: "replacement" }), false);
  assert.equal(sameHostVersion(base, applied), false);
});
test("records interleaved response parts without duplicating tool updates or cumulative proposals", () => {
  const f = fixture();
  f.send({ type: "message.delta", text: "First" });
  f.send({ type: "message.delta", text: " text" });
  f.send({ type: "tool.updated", tool: { id: "query", name: "scene_query", status: "running" } });
  f.send({ type: "message.delta", text: "After query" });
  f.send({ type: "tool.updated", tool: { id: "query", name: "scene_query", status: "completed", output: {} } });
  f.send({ type: "changes.staged", id: "change-1", commands });
  f.send({ type: "message.delta", text: "More work" });
  f.send({ type: "changes.staged", id: "change-1", commands: [...commands, ...commands] });
  f.send({ type: "changes.staged", id: "change-1", commands: [...commands, ...commands] });
  f.send({ type: "message.delta", text: "Ready" });
  f.send({ type: "run.finished", outcome: "failed", error: "network" });
  const message = f.state.messages[1];
  assert.deepEqual(message.parts, [
    { type: "text", start: 0, end: 10 },
    { type: "tool", id: "query" },
    { type: "text", start: 10, end: 21 },
    { type: "changes", start: 0, end: 1 },
    { type: "text", start: 21, end: 30 },
    { type: "changes", start: 1, end: 2 },
    { type: "text", start: 30, end: 35 },
  ]);
  assert.equal(message.toolCalls[0].status, "completed");
  assert.equal(f.state.changeSets[0].interrupted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state)).messages[1].parts, message.parts);
});