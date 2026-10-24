import type { ModelMessage } from "ai";
import type { ProviderRequest } from "../runtime/ports.ts";
import { CONTEXT_OUTPUT_RESERVE, contextWindowTokens, estimateToolContextTokens } from "../runtime/context-window.ts";
import { jsonBytes } from "../runtime/budgets.ts";
import { ModraContextError } from "../runtime/context.ts";
import { currentSceneContext } from "../runtime/scene-context.ts";

/** Check every tool round too; never send an unexpectedly oversized intermediate context. */
export function assertSDKContextWindow(request: ProviderRequest, messages: readonly ModelMessage[]) {
  let tokens =
    CONTEXT_OUTPUT_RESERVE +
    estimateToolContextTokens(request.mode) +
    Math.ceil(jsonBytes(currentSceneContext(request)) / 3);
  for (const message of messages) {
    tokens += 8;
    if (typeof message.content === "string") tokens += Math.ceil(jsonBytes(message.content) / 3);
    else
      for (const content of message.content)
        tokens +=
          content.type === "image" || (content.type === "file" && content.mediaType.startsWith("image/"))
            ? 4096
            : Math.ceil(jsonBytes(content) / 3);
  }
  if (tokens > contextWindowTokens(request.connection.configuration?.contextWindowTokens))
    throw new ModraContextError("context-limit");
}