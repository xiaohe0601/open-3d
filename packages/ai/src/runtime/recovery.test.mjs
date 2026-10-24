import { expect, test } from "vite-plus/test";
import { createModraSession, recoverModraSession, reduceModraSession } from "./index.ts";
import { buildSemanticHistory, describeApplicationOutcome } from "../messages/history.ts";

const base = { generationId: "old", scopeId: "project:one", mutationVersion: 0 };
const evidence = { algorithm: "sha256-native-v1", digest: "a".repeat(64) };
function applied() {
  let state = createModraSession("session", base.scopeId);
  const send = (event) => {
    state = reduceModraSession(state, {
      sessionId: state.id,
      runId: "run",
      sequence: state.lastSequence + 1,
      ...event,
    });
  };
  send({
    type: "run.started",
    taskId: "task",
    messageId: "assistant",
    input: { id: "user", text: "Build", assets: [] },
    base,
    mode: "build",
    approval: "auto",
  });
  send({
    type: "changes.staged",
    id: "change",
    commands: [{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }],
  });
  send({ type: "run.finished", outcome: "completed" });
  send({ type: "review.decided", id: "change", decision: "applied", appliedVersion: { ...base, mutationVersion: 1 } });
  return {
    get state() {
      return state;
    },
    send,
  };
}

test.each([undefined, { ...evidence, digest: "b".repeat(64) }])(
  "applied but unsaved changes remain historical, with unknown scene effects: %j",
  (loaded) => {
    const f = applied();
    f.send({ type: "evidence.recorded", id: "change", appliedVersion: { ...base, mutationVersion: 1 }, evidence });
    const recovered = recoverModraSession(f.state, loaded);
    expect(recovered.changeSets[0].status).toBe("applied");
    expect(recovered.changeSets[0].effect).toBe("unknown");
    expect(recovered.run.phase).toBe("cancelled");
    expect(recovered.run.error).toBe("interrupted");
    const outcome = buildSemanticHistory(recovered, "openai-compatible")
      .flatMap((message) => message.content)
      .find((part) => part.type === "application-outcome");
    expect(describeApplicationOutcome(outcome)).toContain("not established in the current scene");
    expect(f.state.changeSets[0].effect).toBe("present");
  },
);

test("matching native snapshot evidence proves only its own historical effects", () => {
  const f = applied();
  const withoutReceipt = recoverModraSession(f.state, evidence);
  expect(withoutReceipt.changeSets[0].effect).toBe("unknown");
  f.send({ type: "evidence.recorded", id: "change", appliedVersion: { ...base, mutationVersion: 1 }, evidence });
  expect(recoverModraSession(f.state, evidence).changeSets[0].effect).toBe("present");
  // A second receipt cannot rewrite evidence after later unrelated edits.
  const original = f.state;
  f.send({
    type: "evidence.recorded",
    id: "change",
    appliedVersion: { ...base, mutationVersion: 1 },
    evidence: { ...evidence, digest: "b".repeat(64) },
  });
  expect(f.state).toBe(original);
});

test("reload stops unfinished tools and makes an old preview non-applicable without replay", () => {
  const f = applied();
  const state = {
    ...f.state,
    run: { ...f.state.run, phase: "streaming", outcome: null },
    changeSets: f.state.changeSets.map((change) => ({ ...change, status: "staging", appliedVersion: undefined })),
    messages: f.state.messages.map((message) =>
      message.role === "assistant"
        ? { ...message, toolCalls: [{ id: "tool", name: "query_scene_getHierarchy", status: "running", input: {} }] }
        : message,
    ),
  };
  const recovered = recoverModraSession(state);
  expect(recovered.run.outcome).toBe("cancelled");
  expect(recovered.changeSets[0].status).toBe("stale");
  expect(recovered.messages.at(-1).toolCalls[0].status).toBe("cancelled");
  const history = buildSemanticHistory(recovered, "gemini");
  expect(history.flatMap((message) => message.content).some((part) => part.type === "tool-call")).toBe(false);
  expect(history.flatMap((message) => message.content).some((part) => part.type === "interrupted-tool")).toBe(true);
});