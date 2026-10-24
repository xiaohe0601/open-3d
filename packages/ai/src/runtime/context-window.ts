import { buildSemanticHistory, type SemanticMessage } from "../messages/history.ts";
import type { ModraSessionState, TaskMode } from "./contracts.ts";
import { MODELING_COMMANDS, MODELING_QUERIES } from "@open-3d/model-core";
import { jsonBytes } from "./budgets.ts";

export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const CONTEXT_OUTPUT_RESERVE = 4096;
export const CONTEXT_COMPACT_THRESHOLD = 0.8;
export const MAX_CONTEXT_SUMMARY_BYTES = 8192;

export function contextWindowTokens(configured?: number): number {
  return typeof configured === "number" &&
    Number.isSafeInteger(configured) &&
    configured >= 16_384 &&
    configured <= 2_000_000
    ? configured
    : DEFAULT_CONTEXT_WINDOW;
}

// Provider tokenizers and image tiling differ. This is deliberately an estimate, not billing usage.
export function estimateContextTokens(history: readonly SemanticMessage[]): number {
  let tokens = 0;
  for (const message of history) {
    tokens += 8;
    for (const part of message.content) {
      tokens += part.type === "image" ? 4096 : Math.ceil(jsonBytes(part) / 3);
    }
  }
  return tokens;
}

// Include the registered descriptors, with margin for SDK schema expansion and plan-tool framing.
const toolTokens = (commands: boolean) =>
  Math.ceil(
    (jsonBytes([
      ...MODELING_QUERIES.map((item) => ({
        name: item.id,
        description: item.description,
        parameters: item.parameters,
      })),
      ...(commands
        ? MODELING_COMMANDS.map((item) => ({
            name: item.id,
            description:
              item.description + " This only proposes a command for user review; it never edits the document.",
            parameters: item.parameters,
          }))
        : []),
    ]) /
      3) *
      1.2,
  ) + 512;
const toolEstimates = { build: toolTokens(true), plan: toolTokens(false) };
export function estimateToolContextTokens(mode: TaskMode = "build") {
  return toolEstimates[mode];
}

export function contextWindowUsage(
  history: readonly SemanticMessage[],
  configured?: number,
  sceneTokens = 0,
  mode: TaskMode = "build",
) {
  const windowTokens = contextWindowTokens(configured);
  // Allow room for system instructions and tool schemas as well as the next response.
  const inputTokens = estimateContextTokens(history) + sceneTokens + estimateToolContextTokens(mode);
  return {
    inputTokens,
    reservedTokens: CONTEXT_OUTPUT_RESERVE,
    windowTokens,
    ratio: (inputTokens + CONTEXT_OUTPUT_RESERVE) / windowTokens,
  };
}

/** Cut only at user-task boundaries, never between a call/result or auto-approved continuation. */
export function compactionCandidate(state: ModraSessionState, protocol: string) {
  const previous = state.contextCheckpoint
    ? state.messages.findIndex((message) => message.id === state.contextCheckpoint!.throughMessageId)
    : -1;
  const currentTask = state.run?.taskId;
  const latest = state.messages.findIndex((message) => message.taskId === currentTask);
  // Keep the whole current task, even if it is larger than the configured window.
  if (latest <= previous + 1) return null;
  const through = latest - 1;
  const prefix = { ...state, messages: state.messages.slice(0, through + 1) };
  // A failed, unanswered input is not useful summary material, particularly when retrying its images.
  if (
    !prefix.messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.text.trim() || message.toolCalls.length || message.plan || message.changeSetId),
    )
  )
    return null;
  return { throughMessageId: state.messages[through]!.id, history: buildSemanticHistory(prefix, protocol) };
}