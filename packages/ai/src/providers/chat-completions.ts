import { createModelingToolDefinitions } from "../modeling-tools.ts";
import type { ConnectionReference } from "../runtime/ports.ts";
import { streamOpenAICompatibleChat } from "./chat-stream.ts";
import { createSDKProvider, type SDKProviderDependencies } from "./sdk-provider.ts";
import { resolveModelCapabilities } from "./capabilities.ts";
import { currentSceneContext } from "../runtime/scene-context.ts";
import { assertSDKContextWindow } from "./context-budget.ts";
import { CONTEXT_OUTPUT_RESERVE } from "../runtime/context-window.ts";

export interface ChatCompletionsDependencies extends SDKProviderDependencies {
  model(connection: ConnectionReference): { baseURL: string; modelId: string };
}

/** Preserve the original Chat Completions wire format behind the neutral port. */
export function createChatCompletionsProvider(dependencies: ChatCompletionsDependencies) {
  return createSDKProvider(
    {
      ...dependencies,
      capabilities:
        dependencies.capabilities ??
        ((request) =>
          resolveModelCapabilities(request.connection.protocol, dependencies.model(request.connection).modelId)),
    },
    (request, messages, retry) =>
      streamOpenAICompatibleChat({
        config: {
          ...dependencies.model(request.connection),
          apiKey: request.credentials.apiKey,
          fetch: request.transport.fetch,
        },
        messages,
        system: currentSceneContext(request),
        tools: createModelingToolDefinitions(
          (name, input, id) => request.executeTool(id, name, input),
          request.mode,
          true,
        ),
        abortSignal: request.signal,
        retry,
        maxOutputTokens: CONTEXT_OUTPUT_RESERVE,
        prepareStep: ({ messages }) => {
          assertSDKContextWindow(request, messages);
        },
      }),
  );
}