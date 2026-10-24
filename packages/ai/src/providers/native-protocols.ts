import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText, stepCountIs } from "ai";
import { createModelingToolDefinitions } from "../modeling-tools.ts";
import { createRetryingAIFetch } from "../request-retry.ts";
import type { ConnectionReference, ProviderPort } from "../runtime/ports.ts";
import type { AIProtocol } from "../settings.ts";
import { createChatCompletionsProvider } from "./chat-completions.ts";
import { createSDKProvider, type SDKProviderDependencies } from "./sdk-provider.ts";
import { resolveModelCapabilities } from "./capabilities.ts";
import { currentSceneContext } from "../runtime/scene-context.ts";
import { contextCompactor } from "./context-compaction.ts";
import { assertSDKContextWindow } from "./context-budget.ts";
import { CONTEXT_OUTPUT_RESERVE } from "../runtime/context-window.ts";

export interface ProviderDependencies extends SDKProviderDependencies {
  model(connection: ConnectionReference): { baseURL: string; modelId: string };
}

/** Native protocol encoding stays in maintained SDK adapters, not the task runtime. */
export function createNativeProvider(
  protocol: Exclude<AIProtocol, "openai-compatible">,
  dependencies: ProviderDependencies,
): ProviderPort {
  return createSDKProvider(
    {
      ...dependencies,
      capabilities:
        dependencies.capabilities ??
        ((request) => resolveModelCapabilities(protocol, dependencies.model(request.connection).modelId)),
    },
    (request, messages, retry) => {
      const config = dependencies.model(request.connection);
      const options = {
        baseURL: config.baseURL,
        // An explicit empty key avoids ambient Node environment credentials in local callers.
        apiKey: request.credentials.apiKey ?? "",
        fetch: createRetryingAIFetch(request.transport.fetch, retry),
      };
      const model = createNativeModel(protocol, config.modelId, options);
      return streamText({
        onError: () => {},
        model,
        messages,
        system: currentSceneContext(request),
        tools: createModelingToolDefinitions(
          (name, input, id) => request.executeTool(id, name, input),
          request.mode,
          true,
        ),
        abortSignal: request.signal,
        maxRetries: 0,
        maxOutputTokens: CONTEXT_OUTPUT_RESERVE,
        prepareStep: ({ messages }) => {
          assertSDKContextWindow(request, messages);
        },
        ...(protocol === "openai-responses" ? { providerOptions: { openai: { store: false } } } : {}),
        stopWhen: [
          stepCountIs(20),
          ({ steps }) => steps.at(-1)?.content.some((part) => part.type === "tool-error") ?? false,
        ],
      });
    },
  );
}

export function createModraProvider(dependencies: ProviderDependencies): ProviderPort {
  return {
    compact: contextCompactor(dependencies),
    stream(request) {
      const protocol = request.connection.protocol;
      if (protocol === "openai-compatible") return createChatCompletionsProvider(dependencies).stream(request);
      if (protocol === "openai-responses" || protocol === "anthropic-messages" || protocol === "gemini")
        return createNativeProvider(protocol, dependencies).stream(request);
      throw new Error("Unsupported provider protocol");
    },
  };
}

export function createNativeModel(
  protocol: Exclude<AIProtocol, "openai-compatible">,
  modelId: string,
  options: { baseURL: string; apiKey: string; fetch: typeof fetch },
) {
  return protocol === "openai-responses"
    ? createOpenAI(options).responses(modelId)
    : protocol === "anthropic-messages"
      ? createAnthropic({ ...options, headers: { "anthropic-dangerous-direct-browser-access": "true" } }).messages(
          modelId,
        )
      : createGoogleGenerativeAI(options)(modelId);
}