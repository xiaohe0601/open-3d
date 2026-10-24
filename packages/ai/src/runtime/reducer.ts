import type { ChangeSet, ModraEvent, ModraMessage, ModraSessionState, RunPhase } from "./contracts.ts";
import { sameHostVersion } from "./contracts.ts";

const streamingPhases: readonly RunPhase[] = ["connecting", "streaming", "retrying"];
const terminalPhases: readonly RunPhase[] = ["completed", "failed", "cancelled", "stale"];

export function createModraSession(id: string, scopeId: string): ModraSessionState {
  if (!id || !scopeId) throw new Error("Session and scope IDs must be nonempty.");
  return { id, scopeId, lastSequence: 0, run: null, runs: [], messages: [], changeSets: [] };
}

function updateAssistant(state: ModraSessionState, update: (message: ModraMessage) => ModraMessage) {
  return state.messages.map((message) => (message.id === state.run?.messageId ? update(message) : message));
}

function finishTools(state: ModraSessionState, status: "failed" | "cancelled") {
  return updateAssistant(state, (message) => ({
    ...message,
    toolCalls: message.toolCalls.map((tool) =>
      tool.status === "running" || tool.status === "preparing" ? { ...tool, status } : tool,
    ),
  }));
}

/** Invalid or late events are no-ops, including their sequence numbers. */
export function reduceModraSession(state: ModraSessionState, event: ModraEvent): ModraSessionState {
  const next = transition(state, event);
  if (next === state || !next.run || next.run === state.run) return next;
  const run = next.run;
  return {
    ...next,
    runs: state.runs.some((item) => item.id === run.id)
      ? state.runs.map((item) => (item.id === run.id ? run : item))
      : [...state.runs, run],
  };
}

function transition(state: ModraSessionState, event: ModraEvent): ModraSessionState {
  if (event.sessionId !== state.id || !Number.isSafeInteger(event.sequence) || event.sequence <= state.lastSequence) {
    return state;
  }
  if (event.type === "run.started") {
    const previous = state.run;
    const continuing = previous?.phase === "continuing" && previous.taskId === event.taskId && !event.input;
    if (
      !event.runId ||
      !event.taskId ||
      !event.messageId ||
      event.base.scopeId !== state.scopeId ||
      (previous && !terminalPhases.includes(previous.phase) && !continuing) ||
      state.runs.some((run) => run.id === event.runId) ||
      state.messages.some((message) => message.id === event.messageId) ||
      (event.input &&
        (!event.input.id ||
          event.input.id === event.messageId ||
          state.messages.some((message) => message.id === event.input?.id))) ||
      (!event.input && !continuing)
    ) {
      return state;
    }
    const message = {
      ...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
      taskId: event.taskId,
      runId: event.runId,
      base: { ...event.base },
      text: "",
      assets: [],
      toolCalls: [],
    };
    const additions: ModraMessage[] = [];
    if (event.input) {
      additions.push({
        ...message,
        id: event.input.id,
        role: "user",
        text: event.input.text,
        assets: structuredClone(event.input.assets),
        ...(event.input.references?.length ? { references: structuredClone(event.input.references) } : {}),
      });
    }
    additions.push({ ...message, id: event.messageId, role: "assistant", parts: [] });
    return {
      ...state,
      ...(event.queuedId && state.queue
        ? { queue: { ...state.queue, entries: state.queue.entries.filter((entry) => entry.id !== event.queuedId) } }
        : {}),
      lastSequence: event.sequence,
      run: {
        id: event.runId,
        taskId: event.taskId,
        messageId: event.messageId,
        mode: event.mode,
        approval: event.approval,
        base: { ...event.base },
        phase: "connecting",
        outcome: null,
      },
      messages: [...state.messages, ...additions],
    };
  }

  if (event.type === "queue.updated")
    return { ...state, lastSequence: event.sequence, queue: structuredClone(event.queue) };

  if (event.type === "evidence.recorded") {
    const target = state.changeSets.find((change) => change.id === event.id && change.runId === event.runId);
    if (
      target?.status !== "applied" ||
      target.evidence ||
      !target.appliedVersion ||
      !sameHostVersion(target.appliedVersion, event.appliedVersion) ||
      event.evidence.algorithm !== "sha256-native-v1" ||
      !/^[a-f0-9]{64}$/.test(event.evidence.digest)
    )
      return state;
    return {
      ...state,
      lastSequence: event.sequence,
      changeSets: state.changeSets.map((change) =>
        change === target ? { ...change, evidence: { ...event.evidence } } : change,
      ),
    };
  }
  // Historical effects may change after a newer run starts (e.g. Undo).
  if (event.type === "effect.changed") {
    const target = state.changeSets.find((change) => change.id === event.id && change.runId === event.runId);
    if (target?.status !== "applied") return state;
    return {
      ...state,
      lastSequence: event.sequence,
      changeSets: state.changeSets.map((change) => (change === target ? { ...change, effect: event.effect } : change)),
    };
  }

  const run = state.run;
  if (!run || event.runId !== run.id) return state;
  const active = streamingPhases.includes(run.phase);
  const sequenced = { ...state, lastSequence: event.sequence };

  switch (event.type) {
    case "run.compacting":
      return active ? { ...sequenced, run: { ...run, compacting: true } } : state;
    case "context.compacted":
      return active &&
        event.checkpoint.summary.trim() &&
        new TextEncoder().encode(JSON.stringify(event.checkpoint.summary)).byteLength <= 8192 &&
        event.checkpoint.compactions === (state.contextCheckpoint?.compactions ?? 0) + 1 &&
        state.messages.some(
          (message, index) =>
            message.id === event.checkpoint.throughMessageId &&
            message.taskId !== run.taskId &&
            state.messages[index + 1]?.taskId !== message.taskId &&
            index >
              (state.contextCheckpoint
                ? state.messages.findIndex((item) => item.id === state.contextCheckpoint!.throughMessageId)
                : -1),
        )
        ? { ...sequenced, contextCheckpoint: { ...event.checkpoint }, run: { ...run, compacting: false } }
        : state;
    case "plan.updated":
      return active
        ? {
            ...sequenced,
            messages: updateAssistant(state, (message) => ({
              ...message,
              plan: structuredClone(event.plan),
              parts: message.parts?.some((part) => part.type === "plan")
                ? message.parts
                : [...(message.parts ?? []), { type: "plan" }],
            })),
          }
        : state;
    case "run.usage":
      return active ? { ...sequenced, run: { ...run, usage: { ...event.usage } } } : state;
    case "tool.metadata":
      return active
        ? {
            ...sequenced,
            messages: updateAssistant(state, (message) => ({
              ...message,
              toolCalls: message.toolCalls.map((tool) =>
                tool.id === event.id
                  ? { ...tool, providerMetadata: { protocol: event.protocol, value: structuredClone(event.value) } }
                  : tool,
              ),
            })),
          }
        : state;
    case "run.streaming":
      return active ? { ...sequenced, run: { ...run, phase: "streaming", retry: undefined } } : state;
    case "run.retrying":
      return active && event.retry.attempt > 0 && event.retry.attempt <= event.retry.maxRetries
        ? { ...sequenced, run: { ...run, phase: "retrying", retry: { ...event.retry } } }
        : state;
    case "message.delta":
      return active
        ? {
            ...sequenced,
            run: { ...run, phase: "streaming", retry: undefined },
            messages: updateAssistant(state, (message) => {
              if (!event.text) return message;
              const parts = message.parts ?? [];
              const last = parts.at(-1);
              const end = message.text.length + event.text.length;
              return {
                ...message,
                text: message.text + event.text,
                parts:
                  last?.type === "text"
                    ? [...parts.slice(0, -1), { ...last, end }]
                    : [...parts, { type: "text", start: message.text.length, end }],
              };
            }),
          }
        : state;
    case "tool.updated": {
      if (!active || !event.tool.id || !event.tool.name) return state;
      const message = state.messages.find((item) => item.id === run.messageId)!;
      const previous = message.toolCalls.find((tool) => tool.id === event.tool.id);
      if (
        previous &&
        (previous.name !== event.tool.name ||
          ["completed", "failed", "cancelled"].includes(previous.status) ||
          (previous.status === "running" && event.tool.status === "preparing"))
      ) {
        return state;
      }
      return {
        ...sequenced,
        run: { ...run, phase: "streaming", retry: undefined },
        messages: updateAssistant(state, (item) => ({
          ...item,
          parts: previous ? item.parts : [...(item.parts ?? []), { type: "tool", id: event.tool.id }],
          toolCalls: previous
            ? item.toolCalls.map((tool) =>
                tool.id === previous.id
                  ? {
                      ...structuredClone(event.tool),
                      ...(previous.providerMetadata ? { providerMetadata: previous.providerMetadata } : {}),
                    }
                  : tool,
              )
            : [...item.toolCalls, structuredClone(event.tool)],
        })),
      };
    }
    case "changes.staged": {
      if (!active || run.mode !== "build" || !event.id || event.commands.length === 0) return state;
      const previous = state.changeSets.find((change) => change.runId === run.id);
      if (
        (previous && (previous.id !== event.id || previous.status !== "staging")) ||
        state.changeSets.some((change) => change.id === event.id && change.runId !== run.id)
      ) {
        return state;
      }
      const change: ChangeSet = {
        affectedObjects: structuredClone(event.affectedObjects),
        id: event.id,
        taskId: run.taskId,
        runId: run.id,
        messageId: run.messageId,
        base: { ...run.base },
        commands: structuredClone(event.commands),
        status: "staging",
        interrupted: false,
        effect: "unknown",
      };
      return {
        ...sequenced,
        messages: updateAssistant(state, (item) => ({
          ...item,
          changeSetId: change.id,
          // Snapshots are cumulative; only new commands acquire a timeline position.
          parts:
            event.commands.length > (previous?.commands.length ?? 0)
              ? [
                  ...(item.parts ?? []),
                  {
                    type: "changes",
                    start: previous?.commands.length ?? 0,
                    end: event.commands.length,
                  },
                ]
              : item.parts,
        })),
        changeSets: previous
          ? state.changeSets.map((item) => (item === previous ? change : item))
          : [...state.changeSets, change],
      };
    }
    case "run.finished": {
      if (
        !active &&
        run.phase !== "continuing" &&
        !(run.phase === "awaiting-review" && (event.outcome === "cancelled" || event.outcome === "stale"))
      )
        return state;
      const review =
        (event.outcome === "completed" || event.outcome === "failed") &&
        state.changeSets.some((change) => change.runId === run.id && change.status === "staging");
      const messages = finishTools(state, event.outcome === "cancelled" ? "cancelled" : "failed");
      return {
        ...sequenced,
        ...(state.queue && (event.outcome !== "completed" || event.error === "batch-limit")
          ? { queue: { ...state.queue, paused: true } }
          : {}),
        run: {
          ...run,
          phase: review ? "awaiting-review" : event.outcome,
          ...(run.compacting ? { compacting: false } : {}),
          outcome: event.outcome,
          error: event.error,
          retry: undefined,
        },
        messages: messages.filter(
          (item) =>
            item.id !== run.messageId ||
            item.text.trim() ||
            item.toolCalls.length ||
            review ||
            event.outcome === "completed",
        ),
        changeSets: state.changeSets.map((change) =>
          change.runId === run.id && (change.status === "staging" || change.status === "pending")
            ? {
                ...change,
                status: review ? "pending" : event.outcome === "stale" ? "stale" : "rejected",
                interrupted: event.outcome === "failed",
              }
            : change,
        ),
      };
    }
    case "review.decided": {
      const change = state.changeSets.find((item) => item.id === event.id && item.runId === run.id);
      if (run.phase !== "awaiting-review" || change?.status !== "pending") return state;
      if (
        event.decision === "applied" &&
        (!event.appliedVersion ||
          event.appliedVersion.generationId !== change.base.generationId ||
          event.appliedVersion.scopeId !== change.base.scopeId ||
          event.appliedVersion.mutationVersion <= change.base.mutationVersion)
      ) {
        return state;
      }
      return {
        ...sequenced,
        run: {
          ...run,
          phase:
            event.decision === "stale"
              ? "stale"
              : event.decision === "applied" && run.outcome === "completed"
                ? "continuing"
                : (run.outcome ?? "completed"),
        },
        changeSets: state.changeSets.map((item) =>
          item === change
            ? {
                ...item,
                status: event.decision,
                effect: event.decision === "applied" ? "present" : "obsolete",
                appliedVersion: event.appliedVersion ? { ...event.appliedVersion } : undefined,
              }
            : item,
        ),
      };
    }
    case "host.invalidated":
      if (terminalPhases.includes(run.phase)) return state;
      return {
        ...sequenced,
        ...(state.queue ? { queue: { ...state.queue, paused: true } } : {}),
        run: { ...run, phase: "stale", outcome: "stale", retry: undefined },
        messages: finishTools(state, "cancelled"),
        changeSets: state.changeSets.map((change) =>
          change.runId === run.id && (change.status === "staging" || change.status === "pending")
            ? { ...change, status: "stale", effect: "obsolete" }
            : change,
        ),
      };
  }
}