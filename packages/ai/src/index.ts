import { stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AIProviderSettings } from "./settings.ts";
import { createRetryingAIFetch, type AIConnectionRetryOptions } from "./request-retry.ts";
export type { AIConnectionRetry } from "./request-retry.ts";
export * from "./settings.ts";

export type OpenAICompatibleChatMessage = ModelMessage;
export { createAIModelingTools, executeAIModelingTool } from "./modeling-tools.ts";
export type { AIModelingToolResult } from "./modeling-tools.ts";

export type OpenAICompatibleChatConfig = Pick<AIProviderSettings, "baseURL" | "modelId" | "apiKey"> & {
  fetch?: typeof fetch;
};

export interface StreamOpenAICompatibleChatOptions<Tools extends ToolSet = ToolSet> {
  config: OpenAICompatibleChatConfig;
  messages: ModelMessage[];
  tools?: Tools;
  abortSignal?: AbortSignal;
  retry?: AIConnectionRetryOptions;
}

export class OpenAICompatibleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleConfigError";
  }
}

export function createOpenAICompatibleChatModel(config: OpenAICompatibleChatConfig) {
  const baseURL = config.baseURL.trim();
  const modelId = config.modelId.trim();

  if (!baseURL) {
    throw new OpenAICompatibleConfigError("An OpenAI-compatible endpoint URL is required.");
  }
  if (!modelId) {
    throw new OpenAICompatibleConfigError("A model identifier is required.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(baseURL);
  } catch {
    throw new OpenAICompatibleConfigError("The OpenAI-compatible endpoint must be an absolute URL.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new OpenAICompatibleConfigError("The OpenAI-compatible endpoint must use HTTP or HTTPS.");
  }

  const provider = createOpenAICompatible({
    name: "open-3d",
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey: config.apiKey?.trim() || undefined,
    fetch: config.fetch,
  });

  return provider.chatModel(modelId);
}

export function streamOpenAICompatibleChat<Tools extends ToolSet = ToolSet>({
  config,
  messages,
  tools,
  abortSignal,
  retry,
}: StreamOpenAICompatibleChatOptions<Tools>) {
  return streamText({
    model: createOpenAICompatibleChatModel({
      ...config,
      fetch: createRetryingAIFetch(config.fetch ?? globalThis.fetch, retry),
    }),
    messages,
    tools,
    abortSignal,
    maxRetries: 0,
    stopWhen: [
      stepCountIs(20),
      ({ steps }) => steps.at(-1)?.content.some((part) => part.type === "tool-error") ?? false,
    ],
  });
}