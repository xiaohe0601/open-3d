import type { OpenAICompatibleChatMessage } from "@open-3d/ai";
import type { CommandRequest } from "@open-3d/model-core";

export interface ConversationImage {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
}

export interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  images?: ConversationImage[];
  proposals?: CommandRequest[];
  proposalStatus?: "pending" | "accepted" | "rejected";
  proposalReady?: boolean;
  proposalInterrupted?: boolean;
  toolCalls?: ConversationToolCall[];
}

export interface ConversationToolCall {
  id: string;
  name: string;
  status: "preparing" | "running" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
}

export const MAX_CONVERSATION_IMAGES = 6;
export const MAX_CONVERSATION_IMAGE_BYTES = 5 * 1024 * 1024;
export const CONVERSATION_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function validateConversationImages(files: readonly Pick<File, "size" | "type">[], currentCount: number) {
  if (currentCount + files.length > MAX_CONVERSATION_IMAGES) return "imageCountError";
  if (files.some((file) => !CONVERSATION_IMAGE_TYPES.includes(file.type))) return "imageTypeError";
  if (files.some((file) => file.size === 0 || file.size > MAX_CONVERSATION_IMAGE_BYTES)) return "imageSizeError";
  return null;
}

export async function readConversationImage(file: File): Promise<ConversationImage> {
  const bitmap = await createImageBitmap(file);
  bitmap.close();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Invalid image data."));
    };
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error("Image reading cancelled."));
    reader.readAsDataURL(file);
  });
  return { id: crypto.randomUUID(), name: file.name, mediaType: file.type, dataUrl };
}

export function conversationHistory(messages: readonly ConversationMessage[]): OpenAICompatibleChatMessage[] {
  return messages
    .filter((message) => message.text.trim().length > 0 || message.images?.length)
    .map((message): OpenAICompatibleChatMessage => {
      if (message.role === "user" && message.images?.length) {
        return {
          role: "user",
          content: [
            ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
            ...message.images.map((image) => ({
              type: "image" as const,
              image: image.dataUrl,
              mediaType: image.mediaType,
            })),
          ],
        };
      }
      return { role: message.role, content: message.text };
    });
}

export const modelingContinuation: OpenAICompatibleChatMessage = {
  role: "user",
  content:
    "Continue the original modeling task using the current scene. The user approved and applied the proposed changes above. " +
    "Do not repeat completed work. If the original task is complete, briefly confirm completion. " +
    "Otherwise, continue by proposing the next necessary modeling changes for review.",
};