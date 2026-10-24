import { stepCountIs, streamText, type ModelMessage, type ToolSet, type PrepareStepFunction } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AIProviderSettings } from "../settings.ts";
import { createRetryingAIFetch, type AIConnectionRetryOptions } from "../request-retry.ts";
export type OpenAICompatibleChatMessage = ModelMessage;

export type OpenAICompatibleChatConfig = Pick<AIProviderSettings, "baseURL" | "modelId" | "apiKey"> & {
  fetch?: typeof fetch;
};

export interface StreamOpenAICompatibleChatOptions<Tools extends ToolSet = ToolSet> {
  config: OpenAICompatibleChatConfig;
  messages: ModelMessage[];
  system?: string;
  tools?: Tools;
  abortSignal?: AbortSignal;
  retry?: AIConnectionRetryOptions;
  prepareStep?: PrepareStepFunction<Tools>;
  maxOutputTokens?: number;
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
  system,
  tools,
  abortSignal,
  retry,
  prepareStep,
  maxOutputTokens,
}: StreamOpenAICompatibleChatOptions<Tools>) {
  return streamText({
    // The SDK default error logger can include request bodies; errors travel through fullStream instead.
    onError: () => {},
    model: createOpenAICompatibleChatModel({
      ...config,
      fetch: createRetryingAIFetch(config.fetch ?? globalThis.fetch, retry),
    }),
    messages,
    system,
    tools,
    abortSignal,
    maxRetries: 0,
    prepareStep,
    maxOutputTokens,
    stopWhen: [
      stepCountIs(20),
      ({ steps }) => steps.at(-1)?.content.some((part) => part.type === "tool-error") ?? false,
    ],
  });
}