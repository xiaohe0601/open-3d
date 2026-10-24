import type { ProviderRequest } from "../runtime/ports.ts";

export interface ModelCapabilities {
  images: "supported" | "unsupported" | "unknown";
  tools: "supported" | "unsupported" | "unknown";
}

// Conservative exact declarations only. A protocol is not a promise about every model behind it.
const declarations: Record<string, ModelCapabilities> = {
  "openai-compatible:gpt-3.5-turbo": { images: "unsupported", tools: "supported" },
  "openai-compatible:gpt-3.5-turbo-instruct": { images: "unsupported", tools: "unsupported" },
  "gemini:gemini-1.0-pro": { images: "unsupported", tools: "supported" },
};

export function resolveModelCapabilities(protocol: string, modelId: string): ModelCapabilities {
  return { ...(declarations[`${protocol}:${modelId}`] ?? { images: "unknown", tools: "unknown" }) };
}

export class ModraCapabilityError extends Error {
  constructor(readonly capability: "images" | "tools") {
    super(
      capability === "images"
        ? "This model does not support image input. Remove images or choose an image-capable model."
        : "This model does not support the modeling tool protocol. Choose a tool-capable model.",
    );
    this.name = "ModraCapabilityError";
  }
}

export function assertModelCapabilities(request: ProviderRequest, capabilities: ModelCapabilities) {
  if (capabilities.tools === "unsupported") throw new ModraCapabilityError("tools");
  if (
    capabilities.images === "unsupported" &&
    request.history.some((message) => message.content.some((part) => part.type === "image"))
  )
    throw new ModraCapabilityError("images");
}