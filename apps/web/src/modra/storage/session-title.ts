import { shortSessionTitle } from "@open-3d/ai/runtime";
export { shortSessionTitle, limitSessionTitle } from "@open-3d/ai/runtime";
import type { ModraSessionState } from "@open-3d/ai/runtime";

/** Immediate fallback while the first reply and its title request are pending. */
export function automaticSessionTitle(state: ModraSessionState): string | undefined {
  const first = state.messages.find((message) => message.role === "user");
  if (!first) return undefined;
  const text = first.text.trim() || first.assets.map((asset) => asset.name).join(", ");
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return shortSessionTitle(normalized);
}

export function canNameSession(record: { title: string; titleSource?: "auto" | "manual" }) {
  return record.titleSource !== "manual" && ["Untitled session", "未命名会话"].includes(record.title);
}

export function displaySessionTitle(record: { title: string; titleSource?: "auto" | "manual" }, untitled: string) {
  return canNameSession(record) ? untitled : record.title;
}