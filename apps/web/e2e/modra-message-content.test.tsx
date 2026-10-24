import { mockModelFetch } from "./helpers/model-fetch";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { saveAIProviderSettings } from "@open-3d/ai/settings";
import {
  ModraMessageContent,
  CopyMessageText,
  MAX_MARKDOWN_CHARACTERS,
  safeMessageURL,
} from "../src/modra/components/message-content";
import { AIConversationPanel } from "../src/workspace/ai-conversation-panel";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { createProcessor } from "../src/workspace/modeling";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { chatTextResponse } from "../../../tests/fixtures/ai/chat-completions";
import { click, waitForModraReady } from "./helpers/workspace";
import { drainModraClosures } from "../src/modra/controller/use-modra-controller";
import { MODRA_DATABASE_NAME } from "../src/modra/storage/indexeddb-repository";
import "../src/style.css";

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  localStorage.clear();
  await page.viewport(390, 844);
  container = document.createElement("div");
  container.style.width = "350px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  await drainModraClosures();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MODRA_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Session database is still open"));
  });
  container.remove();
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
});

test("renders safe Markdown without executing HTML, loading remote images or enabling unsafe navigation", async () => {
  const text = [
    "# Modeling result",
    "",
    "**Review before applying.**",
    "",
    "- One object",
    "- Two views",
    "",
    "[Documentation](https://example.org/docs)",
    "[Unsafe](javascript:alert%281%29)",
    "[Data](data:text/html,attack)",
    "[Relative](/api/delete)",
    "[Credential](https://user@example.org)",
    "![Tracking pixel](https://tracking.example.org/pixel)",
    "",
    '<img src="https://tracking.example.org/html-pixel" onerror="window.__unsafe=1">',
    "<script>window.__unsafe=1</script>",
    "",
    "```js",
    'const x = "<img src=attack>";',
    "```",
  ].join("\n");
  await act(async () => root.render(<ModraMessageContent text={text} />));
  await expect.element(page.getByRole("heading", { name: "Modeling result" })).toBeVisible();
  expect(container.querySelector("strong")?.textContent).toBe("Review before applying.");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelectorAll("script,img,iframe,object,embed,style")).toHaveLength(0);
  expect(container.querySelectorAll("a")).toHaveLength(1);
  const link = container.querySelector("a")!;
  expect(link.href).toBe("https://example.org/docs");
  expect(link.rel).toBe("noopener noreferrer");
  expect(link.referrerPolicy).toBe("no-referrer");
  expect(container.textContent).toContain("External image not loaded: Tracking pixel");
  expect(container.querySelector("pre")?.textContent).toBe('const x = "<img src=attack>";\n');
  for (const url of [
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "file:///etc/passwd",
    "/delete",
    "//host",
    "https://user@example.org",
  ])
    expect(safeMessageURL(url)).toBeUndefined();
  expect(safeMessageURL("https://example.org/docs")).toBe("https://example.org/docs");
  expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
});

test.each(["en", "zh-CN"] as const)(
  "copies original message and code text, and reports clipboard failure in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language];
    const code = 'const name = "Box";\n';
    const text = `**Result**\n\n\`\`\`js\n${code}\`\`\``;
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await act(async () =>
      root.render(
        <>
          <ModraMessageContent text={text} />
          <CopyMessageText text={text} />
        </>,
      ),
    );
    await click(page.getByRole("button", { name: labels.copyCode, exact: true }));
    expect(write).toHaveBeenLastCalledWith(code);
    await click(page.getByRole("button", { name: labels.copyMessage, exact: true }));
    expect(write).toHaveBeenLastCalledWith(text);
    write.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await click(page.getByRole("button", { name: labels.copyMessage, exact: true }));
    await expect.element(page.getByText(labels.copyFailed, { exact: true })).toBeVisible();
  },
);

test("copy feedback resets three seconds after success, restarts on recopy and ignores obsolete clipboard results", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await act(async () => root.render(<CopyMessageText text="First text" />));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const copy = () => act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await copy();
  expect(container.querySelector(".lucide-check")).not.toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(2999);
  });
  expect(container.querySelector(".lucide-check")).not.toBeNull();
  await copy();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(container.querySelector(".lucide-check")).not.toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(2999);
  });
  expect(container.querySelector(".lucide-check")).toBeNull();
  expect(container.querySelector(".lucide-copy")).not.toBeNull();
  let resolve!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await copy();
  await act(async () => root.render(<CopyMessageText text="Updated text" />));
  await act(async () => resolve());
  expect(container.querySelector(".lucide-check")).toBeNull();
  await copy();
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
});

test("bounds Markdown parsing without truncating a long reply or its copied source", async () => {
  const text = `**${"Long original ".repeat(Math.ceil(MAX_MARKDOWN_CHARACTERS / 10))}**`;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await act(async () =>
    root.render(
      <>
        <ModraMessageContent text={text} />
        <CopyMessageText text={text} />
      </>,
    ),
  );
  expect(container.querySelector("strong")).toBeNull();
  expect(container.querySelector("p:last-child")?.textContent).toBe(text);
  await click(page.getByRole("button", { name: ai.en.copyMessage }));
  expect(write).toHaveBeenLastCalledWith(text);
});

function referenceImage(name: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 10;
  canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
  const bytes = Uint8Array.from(atob(canvas.toDataURL().split(",")[1]!), (value) => value.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

test.each([
  { language: "en", width: 1440, dark: false },
  { language: "zh-CN", width: 390, dark: true },
] as const)(
  "copies historical text without replacing the draft or images or mutating the scene at $width/$language",
  async ({ language, width, dark }) => {
    await initializeI18n(language);
    await page.viewport(width, 844);
    document.documentElement.classList.toggle("dark", dark);
    const labels = ai[language];
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example/v1",
      modelId: "test-model",
    });
    const fetch = mockModelFetch().mockResolvedValue(chatTextResponse("reference", "**Reference received**"));
    const host = new WorkspaceModelingHost(createProcessor(), "temp:test", () => crypto.randomUUID());
    const before = host.snapshot();
    await act(async () =>
      root.render(
        <div style={{ height: 720, display: "flex" }}>
          <AIConversationPanel active modelingHost={host} settingsRevision={0} onOpenSettings={() => {}} />
        </div>,
      ),
    );
    await waitForModraReady();
    const input = page.getByRole("textbox", { name: labels.message, exact: true });
    await act(async () => userEvent.fill(input, "Use both reference views"));
    await act(async () =>
      userEvent.upload(page.getByTestId("ai-image-input"), [referenceImage("front.png"), referenceImage("side.png")]),
    );
    await click(page.getByRole("button", { name: labels.send }));
    await expect.element(page.getByText("Reference received", { exact: true })).toBeVisible();
    await expect.element(input).toBeEnabled();
    await act(async () => userEvent.fill(input, "Keep my new draft"));
    await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), [referenceImage("new.png")]));
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const copy = page.getByRole("button", { name: labels.copyMessage, exact: true }).first();
    expect(copy.element().textContent).toBe("");
    await click(copy);
    expect(write).toHaveBeenLastCalledWith("Use both reference views");
    await expect.element(input).toHaveValue("Keep my new draft");
    expect(container.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
    expect(container.querySelectorAll(".ai-message:first-child img")).toHaveLength(2);
    expect(page.getByRole("button", { name: labels.reusePrompt, exact: true }).query()).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(host.snapshot()).toEqual(before);
    expect(host.processor.historyLength).toBe(0);
  },
);