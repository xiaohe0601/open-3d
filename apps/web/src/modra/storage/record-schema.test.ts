import { expect, test } from "vite-plus/test";
import { createModraSession, reduceModraSession, recoverModraSession, type ModraEvent } from "@open-3d/ai/runtime";
import { sessionRecordSchema } from "./record-schema";

function record() {
  const base = { scopeId: "scope", generationId: "generation", mutationVersion: 0 };
  let state = createModraSession("session", base.scopeId);
  const events = [
    {
      type: "run.started",
      taskId: "task",
      messageId: "assistant",
      input: { id: "user", text: "Create", assets: [] },
      mode: "build",
      approval: "request",
      base,
    },
    { type: "message.delta", text: "Before" },
    { type: "tool.updated", tool: { id: "tool", name: "create", status: "running" } },
    {
      type: "changes.staged",
      id: "change",
      commands: [{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }],
    },
    { type: "tool.updated", tool: { id: "tool", name: "create", status: "completed" } },
    { type: "message.delta", text: "After" },
    { type: "run.finished", outcome: "completed" },
  ];
  events.forEach((event, index) => {
    state = reduceModraSession(state, {
      ...event,
      sessionId: state.id,
      runId: "run",
      sequence: index + 1,
    } as ModraEvent);
  });
  return {
    id: state.id,
    scopeId: state.scopeId,
    schemaVersion: 1,
    revision: 1,
    title: "Model",
    createdAt: 0,
    updatedAt: 0,
    state,
    draft: { text: "", assets: [] },
  };
}

test("validates persisted response order and preserves it during interrupted-session recovery", () => {
  const original = record();
  const saved = sessionRecordSchema.parse(JSON.parse(JSON.stringify(original)));
  expect(saved.state.messages[1]!.parts?.map((part) => part.type)).toEqual(["text", "tool", "changes", "text"]);
  expect(recoverModraSession(saved.state).messages[1]!.parts).toEqual(original.state.messages[1]!.parts);
  const legacy = record();
  delete legacy.state.messages[1]!.parts;
  expect(sessionRecordSchema.safeParse(legacy).success).toBe(true);
});

test("context checkpoints round-trip and reject missing or split-task boundaries", () => {
  const value = record();
  value.state.contextCheckpoint = {
    throughMessageId: "assistant",
    summary: "Historical constraints only",
    compactions: 1,
  };
  expect(sessionRecordSchema.parse(value).state.contextCheckpoint).toEqual(value.state.contextCheckpoint);
  expect(recoverModraSession(sessionRecordSchema.parse(value).state).contextCheckpoint).toEqual(
    value.state.contextCheckpoint,
  );
  value.state.contextCheckpoint.throughMessageId = "missing";
  expect(sessionRecordSchema.safeParse(value).success).toBe(false);
  value.state.contextCheckpoint.throughMessageId = "user";
  expect(sessionRecordSchema.safeParse(value).success).toBe(false);
});

test.each(["missing tool", "out of bounds", "omitted text", "duplicated changes"])(
  "rejects corrupt timeline: %s",
  (kind) => {
    const value = record();
    const message = value.state.messages[1]!;
    const parts = [...message.parts!];
    if (kind === "missing tool") parts[1] = { type: "tool", id: "unknown" };
    if (kind === "out of bounds") parts[0] = { type: "text", start: 0, end: 999 };
    if (kind === "omitted text") parts.pop();
    if (kind === "duplicated changes") parts.push({ type: "changes", start: 0, end: 1 });
    message.parts = parts;
    expect(sessionRecordSchema.safeParse(value).success).toBe(false);
  },
);