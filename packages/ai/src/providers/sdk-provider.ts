import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import type { AIConnectionRetryOptions } from "../request-retry.ts";
import type { AssetReference } from "../runtime/contracts.ts";
import type { ProviderPort, ProviderChunk, ProviderRequest } from "../runtime/ports.ts";
import { toSDKHistory } from "./sdk-history.ts";
import { assertModelCapabilities, type ModelCapabilities } from "./capabilities.ts";
import { assertContextBudget } from "../runtime/budgets.ts";
import { ModraContextError } from "../runtime/context.ts";

export interface SDKProviderDependencies {
  image: (asset: AssetReference) => string | Uint8Array;
  retryTiming?: { initialDelayMs: number };
  capabilities?: (request: ProviderRequest) => ModelCapabilities;
}
export function createSDKProvider(
  dependencies: SDKProviderDependencies,
  start: (
    request: ProviderRequest,
    messages: ModelMessage[],
    retry: AIConnectionRetryOptions,
  ) => { fullStream: AsyncIterable<TextStreamPart<ToolSet>> },
): ProviderPort {
  return {
    async *stream(request) {
      request.assertActive();
      assertContextBudget(request.history);
      if (dependencies.capabilities) assertModelCapabilities(request, dependencies.capabilities(request));
      const messages = toSDKHistory(request, dependencies.image);
      const queue: ProviderChunk[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      const push = (chunk: ProviderChunk) => {
        queue.push(chunk);
        wake?.();
      };
      const result = start(request, messages, {
        ...dependencies.retryTiming,
        assertActive: () => request.assertActive(),
        onRetry: (retry) => {
          if (retry) push({ type: "retry", ...retry });
        },
      });
      // Retry notifications can arrive while the SDK iterator is waiting for its first chunk.
      void (async () => {
        try {
          for await (const part of result.fullStream) {
            if (request.signal.aborted) break;
            if (part.type === "start-step") push({ type: "step-start" });
            if (part.type === "text-delta") push({ type: "text-delta", text: part.text });
            if (part.type === "tool-input-start") push({ type: "tool-preparing", id: part.id, name: part.toolName });
            if (part.type === "tool-call" && part.providerMetadata)
              push({ type: "tool-metadata", id: part.toolCallId, metadata: part.providerMetadata });
            if (part.type === "finish") if (part.finishReason === "length") throw new ModraContextError("output-limit");
            if (part.type === "finish")
              push({
                type: "usage",
                inputTokens: part.totalUsage.inputTokens,
                outputTokens: part.totalUsage.outputTokens,
              });
            if (part.type === "error" || part.type === "tool-error") throw part.error;
          }
        } catch (error) {
          push({ type: "error", error });
        } finally {
          done = true;
          wake?.();
        }
      })();
      while (!done || queue.length) {
        while (queue.length) yield queue.shift()!;
        if (!done)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
}