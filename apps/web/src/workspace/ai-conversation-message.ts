import type { CommandRequest } from "@open-3d/model-core";

export interface ConversationImage {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
}

export interface ConversationMessage {
  createdAt?: number;
  parts?: readonly import("@open-3d/ai/runtime").ModraMessagePart[];
  affectedObjects?: readonly import("@open-3d/ai/runtime").AffectedObject[];
  plan?: import("@open-3d/ai/runtime").TaskPlan;
  taskMode?: "plan" | "build";
  references?: (import("@open-3d/ai/runtime").ObjectReference & { currentName?: string; mutationVersion?: number })[];
  id: string | number;
  role: "user" | "assistant";
  text: string;
  images?: ConversationImage[];
  proposals?: CommandRequest[];
  changeSetId?: string;
  proposalStatus?: "pending" | "accepted" | "rejected" | "stale";
  proposalReady?: boolean;
  proposalInterrupted?: boolean;
  applicationEffect?: "present" | "undone" | "unknown" | "obsolete";
  toolCalls?: ConversationToolCall[];
}

export interface ConversationToolCall {
  id: string;
  name: string;
  status: "preparing" | "running" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
}

export const MAX_CONVERSATION_IMAGES = 5;
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