import type { ModraRun, ModraSessionState, SceneEvidence } from "./contracts.ts";

const interrupted = (run: ModraRun): ModraRun =>
  ["connecting", "streaming", "retrying", "awaiting-review", "continuing"].includes(run.phase)
    ? {
        ...run,
        ...(run.compacting ? { compacting: false } : {}),
        phase: "cancelled",
        outcome: "cancelled",
        error: "interrupted",
        retry: undefined,
      }
    : run;

/** Pure recovery, invoked only after acquiring the next writer epoch. Never executes scene work. */
export function recoverModraSession(saved: ModraSessionState, loadedScene?: SceneEvidence): ModraSessionState {
  const state = structuredClone(saved);
  return {
    ...state,
    ...(state.queue ? { queue: { ...state.queue, paused: true } } : {}),
    lastSequence: state.lastSequence + 1,
    run: state.run ? interrupted(state.run) : null,
    runs: state.runs.map(interrupted),
    messages: state.messages.map((message) => ({
      ...message,
      toolCalls: message.toolCalls.map((tool) =>
        tool.status === "preparing" || tool.status === "running" ? { ...tool, status: "cancelled" } : tool,
      ),
    })),
    changeSets: state.changeSets.map((change) => ({
      ...change,
      status: change.status === "staging" || change.status === "pending" ? "stale" : change.status,
      effect:
        change.status === "applied"
          ? change.evidence &&
            loadedScene &&
            change.evidence.algorithm === loadedScene.algorithm &&
            change.evidence.digest === loadedScene.digest
            ? "present"
            : "unknown"
          : "obsolete",
    })),
  };
}