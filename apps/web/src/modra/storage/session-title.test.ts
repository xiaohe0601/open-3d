import { expect, test } from "vite-plus/test";
import { createModraSession, type ModraMessage } from "@open-3d/ai/runtime";
import { automaticSessionTitle, canNameSession, displaySessionTitle } from "./session-title";

function session(text: string, names: string[] = []) {
  const state = createModraSession("title-test", "scope");
  const message: ModraMessage = {
    id: "message",
    taskId: "task",
    runId: "run",
    role: "user",
    text,
    base: { scopeId: "scope", generationId: "generation", mutationVersion: 0 },
    assets: names.map((name, i) => ({ assetId: String(i), name, mediaType: "image/png", byteLength: 10 })),
    toolCalls: [],
  };
  return { ...state, messages: [message] };
}

test("names a session from its first request, normalizing whitespace and bounding Unicode titles", () => {
  expect(automaticSessionTitle(session("  Build a\n reading   lamp  "))).toBe("Build a re");
  expect(automaticSessionTitle(session("灯".repeat(80)))).toBe("灯".repeat(10));
  expect(automaticSessionTitle(session("😀".repeat(80)))).toBe("😀".repeat(10));
  expect(automaticSessionTitle(createModraSession("empty", "scope"))).toBeUndefined();
});

test("image-only requests use filenames and manually named sessions are protected", () => {
  expect(automaticSessionTitle(session("", ["front.png", "side.png"]))).toBe("front.png,");
  expect(canNameSession({ title: "Untitled session" })).toBe(true);
  expect(canNameSession({ title: "未命名会话" })).toBe(true);
  expect(canNameSession({ title: "Untitled session", titleSource: "manual" })).toBe(false);
  expect(canNameSession({ title: "Custom project" })).toBe(false);
});

test("localizes default titles on display without changing manual titles", () => {
  expect(displaySessionTitle({ title: "Untitled session" }, "未命名会话")).toBe("未命名会话");
  expect(displaySessionTitle({ title: "未命名会话", titleSource: "auto" }, "Untitled session")).toBe(
    "Untitled session",
  );
  expect(displaySessionTitle({ title: "Untitled session", titleSource: "manual" }, "未命名会话")).toBe(
    "Untitled session",
  );
  expect(displaySessionTitle({ title: "Desk lamp" }, "未命名会话")).toBe("Desk lamp");
});