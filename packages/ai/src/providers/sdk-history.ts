import type { ModelMessage, UserContent, AssistantContent, ToolContent } from "ai";
import type { AssetReference } from "../runtime/contracts.ts";
import type { ProviderRequest } from "../runtime/ports.ts";
import { describeApplicationOutcome } from "../messages/history.ts";

type ProviderOptions = NonNullable<
  Extract<Exclude<AssistantContent, string>[number], { type: "tool-call" }>["providerOptions"]
>;

export function toSDKHistory(
  request: ProviderRequest,
  image: (asset: AssetReference) => string | Uint8Array,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of request.history) {
    const user: UserContent = [];
    const assistant: AssistantContent = [];
    const results: ToolContent = [];
    for (const content of message.content) {
      if (content.type === "text") {
        user.push({ type: "text", text: content.text });
        assistant.push({ type: "text", text: content.text });
      }
      if (content.type === "image")
        user.push({ type: "image", image: image(content.asset), mediaType: content.asset.mediaType });
      if (content.type === "tool-call")
        assistant.push({
          type: "tool-call",
          toolCallId: content.id,
          toolName: content.name,
          input: content.input,
          ...(content.metadata && typeof content.metadata === "object"
            ? { providerOptions: content.metadata as ProviderOptions }
            : {}),
        });
      if (content.type === "tool-result")
        results.push({
          type: "tool-result",
          toolCallId: content.id,
          toolName: content.name,
          output: { type: "json", value: JSON.parse(JSON.stringify(content.output)) },
        });
      if (content.type === "interrupted-tool") {
        const text = `Tool ${content.name} was ${content.status}; no completed result is available.`;
        assistant.push({ type: "text", text });
      }
      if (content.type === "application-outcome") {
        const text = describeApplicationOutcome(content);
        user.push({ type: "text", text });
      }
    }
    if (message.role === "tool" && results.length) messages.push({ role: "tool", content: results });
    if (message.role === "assistant" && assistant.length) messages.push({ role: "assistant", content: assistant });
    if (message.role === "user" && user.length) {
      messages.push({ role: "user", content: user.length === 1 && user[0]?.type === "text" ? user[0].text : user });
    }
  }
  // A continuation is explicit and never resubmits a historical command as a new operation.
  const last = request.history.at(-1);
  if (last?.content.some((part) => part.type === "application-outcome" && part.decision === "applied")) {
    messages.push({
      role: "user",
      content:
        "Continue the original modeling task using the current scene. The user approved and applied the proposed changes above. " +
        "Do not repeat completed work. If the original task is complete, briefly confirm completion. " +
        "Otherwise, continue by proposing the next necessary modeling changes for review.",
    });
  }

  return messages;
}