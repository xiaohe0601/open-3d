import { mockModelFetch } from "./helpers/model-fetch";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { serializeNativeProject } from "@open-3d/projects";
import { exportGltf } from "@open-3d/projects/gltf";
import { saveAIProviderSettings } from "@open-3d/ai/settings";
import { AIConversationPanel } from "../src/workspace/ai-conversation-panel";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { drainModraClosures } from "../src/modra/controller/use-modra-controller";
import {
  IndexedDBModraRepository,
  ModraStorageError,
  MODRA_DATABASE_NAME,
} from "../src/modra/storage/indexeddb-repository";
import { createProcessor } from "../src/workspace/modeling";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { click, fill, waitForModraReady, waitForModraIdle } from "./helpers/workspace";
import {
  chatTextResponse,
  chatToolCallResponse,
  controlledChatResponse,
} from "../../../tests/fixtures/ai/chat-completions";
import "../src/style.css";

let root: Root;
let container: HTMLDivElement;
let repository: IndexedDBModraRepository;
const scope = "temporary:durable-ui";
const input = () => page.getByRole("textbox", { name: ai.en.message, exact: true });
const host = () => new WorkspaceModelingHost(createProcessor(), scope, () => crypto.randomUUID());
function panel(modelingHost: WorkspaceModelingHost) {
  return (
    <div style={{ height: 740, width: 350, display: "flex" }}>
      <AIConversationPanel active modelingHost={modelingHost} settingsRevision={0} onOpenSettings={() => {}} />
    </div>
  );
}
async function mount(modelingHost = host()) {
  await act(async () => root.render(panel(modelingHost)));
  await waitForModraReady();
  return modelingHost;
}
async function unmount() {
  await act(async () => root.render(null));
  await drainModraClosures();
}
async function send(text: string) {
  await act(async () => userEvent.fill(input(), text));
  await click(page.getByRole("button", { name: ai.en.send, exact: true }));
}
async function deleteDatabase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MODRA_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("A session connection leaked"));
  });
}
function image() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 10;
  canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
  return new File(
    [Uint8Array.from(atob(canvas.toDataURL().split(",")[1]!), (byte) => byte.charCodeAt(0))],
    "view.png",
    { type: "image/png" },
  );
}
beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  localStorage.clear();
  await deleteDatabase();
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example/v1",
    modelId: "test-model",
  });
  await page.viewport(390, 844);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  repository = new IndexedDBModraRepository();
});
afterEach(async () => {
  await act(async () => root.unmount());
  await drainModraClosures();
  await repository.close();
  vi.restoreAllMocks();
  container.remove();
  await deleteDatabase();
});

test("production controller reloads transcript, draft and local images without requests or scene restoration", async () => {
  const fetch = mockModelFetch().mockImplementation(async () => chatTextResponse("saved", "A durable answer"));
  const original = await mount();
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), image()));
  await expect.poll(() => container.querySelectorAll(".ai-prompt-form img").length).toBe(1);
  await send("Model from this reference");
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  await act(async () => userEvent.fill(input(), "Unsent draft"));
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), image()));
  // Upload dispatch does not await asynchronous image decoding and draft hydration.
  await expect.poll(() => container.querySelectorAll(".ai-prompt-form img").length).toBe(1);
  await unmount();
  const records = await repository.list(scope);
  expect(records).toHaveLength(1);
  expect(records[0]!.title).toBe("Modeling");
  expect(records[0]!.draft.text).toBe("Unsent draft");
  expect(records[0]!.draft.assets).toHaveLength(1);
  const reopened = await mount();
  await expect.element(input()).toHaveValue("Unsent draft");
  await expect.element(page.getByText("A durable answer", { exact: true })).toBeVisible();
  expect(container.querySelectorAll(".ai-message img")).toHaveLength(1);
  expect(container.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
  expect(reopened.snapshot().document).toEqual(original.snapshot().document);
  expect(reopened.processor.historyLength).toBe(0);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each(["en", "zh-CN"] as const)(
  "default session names follow display language without rewriting data in %s",
  async (language) => {
    const record = await repository.create(scope);
    await initializeI18n(language);
    await mount();
    await click(page.getByRole("button", { name: ai[language].sessions, exact: true }));
    const dialog = () => page.getByRole("dialog", { name: ai[language].sessions, exact: true });
    await expect
      .element(dialog().getByRole("button", { name: ai[language].sessionUntitled, exact: true }))
      .toBeVisible();
    const next = language === "en" ? "zh-CN" : "en";
    await act(async () => initializeI18n(next));
    await expect
      .element(
        page
          .getByRole("dialog", { name: ai[next].sessions, exact: true })
          .getByRole("button", { name: ai[next].sessionUntitled, exact: true }),
      )
      .toBeVisible();
    expect((await repository.load(record.id))!.title).toBe("Untitled session");
  },
);

test("context indicator and automatic compaction persist summaries without removing messages or local images", async () => {
  const longReply = "Earlier dimensions and modeling constraints. ".repeat(1500);
  let modeling = 0;
  const fetch = mockModelFetch().mockImplementation(async (_input, init) => {
    if (JSON.stringify(JSON.parse(init!.body as string)).includes("Compact this modeling conversation"))
      return chatTextResponse(
        "summary",
        "Goal: preserve the agreed dimensions. Inspect the current scene before applying changes.",
      );
    modeling++;
    return chatTextResponse(
      String(modeling),
      modeling === 1
        ? longReply
        : modeling === 2
          ? "Continuing with the original dimensions."
          : "The context summary is still available.",
    );
  });
  const modelingHost = await mount();
  await click(page.getByRole("button", { name: ai.en.contextWindow, exact: true }));
  await expect.element(page.getByText(/32,768/).first()).toBeVisible();
  await act(async () => userEvent.keyboard("{Escape}"));
  await userEvent.upload(page.getByTestId("ai-image-input"), image());
  await expect.element(page.getByRole("button", { name: "Remove view.png", exact: true })).toBeVisible();
  await send("First modeling question");
  await waitForModraIdle();
  await send("Continue with the agreed dimensions");
  await expect.element(page.getByText("Continuing with the original dimensions.", { exact: true })).toBeVisible();
  await waitForModraIdle();
  expect(modeling).toBe(2);
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  const summaryBody = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  expect(summaryBody.tools).toBeUndefined();
  expect(JSON.stringify(summaryBody)).not.toContain("data:image");
  expect(JSON.stringify(summaryBody)).toContain("Compact this modeling conversation");
  await unmount();
  const saved = (await repository.list(scope))[0]!;
  expect(saved.state.messages).toHaveLength(4);
  expect(saved.state.messages[1]!.text).toBe(longReply);
  expect(saved.state.messages[0]!.assets).toHaveLength(1);
  expect(saved.state.contextCheckpoint?.compactions).toBe(1);
  expect(saved.state.contextCheckpoint?.throughMessageId).toBe(saved.state.messages[1]!.id);
  await mount(modelingHost);
  await click(page.getByRole("button", { name: ai.en.contextWindow, exact: true }));
  await expect.element(page.getByText("Compactions: 1", { exact: true })).toBeVisible();
  await act(async () => userEvent.keyboard("{Escape}"));
  await send("One more question");
  await expect.element(page.getByText("The context summary is still available.", { exact: true })).toBeVisible();
  expect(modeling).toBe(3);
  const resumedBody = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
  expect(JSON.stringify(resumedBody)).toContain("Goal: preserve the agreed dimensions");
  expect(JSON.stringify(resumedBody)).not.toContain(longReply);
  expect(modelingHost.snapshot().document.objects).toHaveLength(0);
});

test.each([
  { width: 1440, language: "en" },
  { width: 768, language: "en" },
  { width: 390, language: "zh-CN" },
] as const)("context window details fit and localize at $width/$language", async ({ width, language }) => {
  await initializeI18n(language);
  await page.viewport(width, 844);
  await mount();
  const strings = ai[language];
  await click(page.getByRole("button", { name: strings.contextWindow, exact: true }));
  const popup = page.getByRole("dialog", { name: strings.contextWindow, exact: true });
  await expect.element(popup).toBeVisible();
  const element = popup.element();
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  const bounds = element.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(element.querySelectorAll("p")).toHaveLength(0);
  expect(element.textContent).not.toContain(strings.contextAutoNotice);
});

test("session dialog height stays fixed when a short list grows into a scrolling history", async () => {
  await mount();
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  const dialog = page.getByRole("dialog", { name: ai.en.sessions, exact: true });
  const height = dialog.element().getBoundingClientRect().height;
  await click(dialog.getByRole("button", { name: ai.en.closeSessions, exact: true }));
  for (let index = 0; index < 18; index++) await repository.create(scope, `History ${index}`);
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await expect.element(dialog.getByRole("button", { name: "History 17", exact: true })).toBeInTheDocument();
  const list = dialog.getByTestId("modra-session-list").element();
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(dialog.element().getBoundingClientRect().height).toBeCloseTo(height, 0);
  expect(dialog.element().scrollHeight).toBeLessThanOrEqual(dialog.element().clientHeight);
});

test("empty sessions stay in memory until sent or renamed, and New on an empty session preserves its draft", async () => {
  const fetch = mockModelFetch();
  await mount();
  await fill(input(), "First draft");
  await userEvent.upload(page.getByTestId("ai-image-input"), image());
  await expect.poll(() => container.querySelectorAll(".ai-prompt-form img").length).toBe(1);
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: ai.en.sessionCreate, exact: true }));
  await expect.element(input()).toHaveValue("First draft");
  expect(container.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
  expect(await repository.list(scope)).toHaveLength(0);
  async function renameCurrent(title: string) {
    await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
    await click(page.getByRole("button", { name: `Rename ${ai.en.sessionUntitled}`, exact: true }));
    await fill(page.getByRole("textbox", { name: ai.en.sessionTitle }), title);
    await click(page.getByRole("button", { name: ai.en.sessionRenameSave }));
  }
  await renameCurrent("First");
  await expect.poll(async () => (await repository.list(scope)).length).toBe(1);
  await click(page.getByRole("button", { name: ai.en.sessionCreate, exact: true }));
  await expect.element(input()).toHaveValue("");
  expect(await repository.list(scope)).toHaveLength(1);
  await fill(input(), "Second draft");
  await renameCurrent("Second");
  await expect.poll(async () => (await repository.list(scope)).length).toBe(2);
  await click(page.getByRole("button", { name: "First", exact: true }));
  await expect.element(input()).toHaveValue("First draft");
  expect(container.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: "Delete Second", exact: true }));
  await click(page.getByRole("button", { name: ai.en.sessionDeleteConfirm, exact: true }));
  await expect.poll(async () => (await repository.list(scope)).length).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

test("pasted images share upload validation and sending persists the first real task", async () => {
  const fetch = mockModelFetch().mockImplementation(async () => chatTextResponse("paste", "Reference received"));
  await mount();
  function paste(files: File[]) {
    const data = new DataTransfer();
    files.forEach((file) => data.items.add(file));
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    return act(async () => {
      input().element().dispatchEvent(event);
    });
  }
  await paste([image()]);
  await expect.poll(() => container.querySelectorAll(".ai-prompt-form img").length).toBe(1);
  expect(await repository.list(scope)).toHaveLength(0);
  await paste(Array.from({ length: 5 }, image));
  await expect.element(page.getByRole("alert")).toHaveTextContent(ai.en.imageCountError);
  expect(container.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
  await paste([new File(["invalid"], "bad.png", { type: "image/png" })]);
  await expect.element(page.getByRole("alert")).toHaveTextContent(ai.en.imageReadError);
  const data = new DataTransfer();
  data.setData("text/plain", "Ordinary text");
  const plain = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  input().element().dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(false);
  await click(page.getByRole("button", { name: ai.en.send, exact: true }));
  await waitForModraIdle();
  await expect.element(page.getByText("Reference received", { exact: true })).toBeVisible();
  const records = await repository.list(scope);
  expect(records).toHaveLength(1);
  expect(records[0]!.state.messages[0]!.assets).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
});

test("switching during generation requires confirmation and leaves no late output or implicit request", async () => {
  const stream = controlledChatResponse();
  const fetch = mockModelFetch().mockResolvedValue(stream.response);
  await mount();
  await send("An unfinished task");
  await act(async () => stream.text("Partial response"));
  await expect.element(page.getByText("Partial response", { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: ai.en.sessionCreate }));
  const confirmation = page.getByRole("dialog", { name: ai.en.sessionSwitchTitle });
  await click(confirmation.getByRole("button", { name: ai.en.sessionCancel }));
  expect(await repository.list(scope)).toHaveLength(1);
  await click(page.getByRole("button", { name: ai.en.sessionCreate }));
  await click(confirmation.getByRole("button", { name: ai.en.sessionSwitchConfirm }));
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  await act(async () => {
    stream.text("Must not move into the new session");
    stream.finish();
  });
  expect(container.textContent).not.toContain("Partial response");
  expect(container.textContent).not.toContain("Must not move");
  expect(fetch).toHaveBeenCalledOnce();
  expect(await repository.list(scope)).toHaveLength(1);
});

test("a secondary production view stays read-only and uses a distinct memory session only on explicit action", async () => {
  const record = await repository.create(scope, "Live elsewhere");
  const token = await repository.acquire(record.id, scope);
  await repository.saveDraft({ text: "Other tab draft", assets: [] }, token);
  const fetch = mockModelFetch();
  await mount();
  await expect.element(input()).toBeDisabled();
  await expect.element(page.getByText(ai.en.sessionReadOnly, { exact: true })).toBeVisible();
  await expect.element(input()).toHaveValue("Other tab draft");
  const revision = (await repository.load(record.id))!.revision;
  await click(page.getByRole("button", { name: ai.en.sessionContinueMemory }));
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  await act(async () => userEvent.fill(input(), "Independent draft"));
  await unmount();
  const stored = (await repository.load(record.id))!;
  expect(stored.revision).toBe(revision);
  expect(stored.draft.text).toBe("Other tab draft");
  expect(fetch).not.toHaveBeenCalled();
});

test("quota failures retain the active reply and allow persistence-only retry", async () => {
  const stream = controlledChatResponse();
  const fetch = mockModelFetch().mockResolvedValue(stream.response);
  await mount();
  await send("Keep this work on quota failure");
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!.value as IDBObjectStore["put"];
  const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "sessions") throw new DOMException("Full", "QuotaExceededError");
    return put.apply(this, args);
  });
  await act(async () => {
    stream.text("Keep this answer");
    stream.finish();
  });
  await expect.element(page.getByText(ai.en.sessionSaveError, { exact: true })).toBeVisible();
  await expect.element(page.getByText("Keep this answer", { exact: true })).toBeVisible();
  fault.mockRestore();
  await click(page.getByRole("button", { name: ai.en.sessionRetrySave }));
  await expect
    .poll(() => container.querySelector("[data-modra-durability]")?.getAttribute("data-modra-durability"))
    .toBe("saved");
  await expect.element(page.getByText(ai.en.sessionSaved, { exact: true })).not.toBeInTheDocument();
  await unmount();
  expect((await repository.list(scope))[0]!.state.messages.some((message) => message.text === "Keep this answer")).toBe(
    true,
  );
  expect(fetch).toHaveBeenCalledOnce();
});

test("an unsupported database version stays untouched and falls back to an independent memory session", async () => {
  await repository.close();
  await deleteDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(MODRA_DATABASE_NAME, 2);
    request.onupgradeneeded = () => request.result.createObjectStore("future");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  await mount();
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  await expect.element(page.getByText(ai.en.sessionMemory, { exact: true })).toBeVisible();
  await expect.element(page.getByText(ai.en.sessionNewerVersion, { exact: true })).toBeVisible();
  await act(async () => userEvent.fill(input(), "Only in memory"));
  await unmount();
  expect((await indexedDB.databases()).find((database) => database.name === MODRA_DATABASE_NAME)?.version).toBe(2);
});

test("session manager only lists the current project without exposing legacy unrelated history", async () => {
  const old = await repository.create("temporary:legacy", "Legacy history");
  await mount();
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  const manager = page.getByRole("dialog", { name: ai.en.sessions, exact: true });
  expect(manager.element().textContent).not.toContain("Legacy history");
  expect(manager.element().querySelector("section")).toBeNull();
  expect(await repository.load(old.id)).not.toBeNull();
});

test("session deletion keeps a failed cleanup sealed and offers a repeatable retry", async () => {
  await repository.create(scope);
  await mount();
  await act(async () => userEvent.fill(input(), "Draft scheduled for deletion"));
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  const record = (await repository.list(scope))[0]!;
  const cleanup = vi
    .spyOn(IndexedDBModraRepository.prototype, "cleanup")
    .mockRejectedValueOnce(new Error("Unavailable"));
  await click(page.getByRole("button", { name: `Delete ${record.title}`, exact: true }));
  const confirmation = page.getByRole("dialog", { name: ai.en.sessionDeleteTitle });
  await click(confirmation.getByRole("button", { name: ai.en.sessionDeleteConfirm }));
  await expect.element(confirmation.getByRole("alert")).toBeVisible();
  await expect(repository.acquire(record.id, scope)).rejects.toMatchObject({ code: "fenced" });
  expect((await repository.load(record.id))!.draft.text).toBe("Draft scheduled for deletion");
  await click(confirmation.getByRole("button", { name: ai.en.sessionCancel }));
  await click(page.getByRole("button", { name: `Retry deleting ${record.title}`, exact: true }));
  await click(confirmation.getByRole("button", { name: ai.en.sessionDeleteConfirm }));
  await expect.poll(async () => await repository.load(record.id)).toBeNull();
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

test.each(["saved", "unsaved"] as const)(
  "production reload qualifies %s scene effects without replaying historical commands",
  async (scene) => {
    const fetch = mockModelFetch()
      .mockResolvedValueOnce(
        chatToolCallResponse("evidence", "command_scene_createPrimitive", { primitive: "box", name: "Evidence box" }),
      )
      .mockImplementation(async () => chatTextResponse("done", "Completed modeling task"));
    const original = await mount();
    const savedBefore = original.snapshot().document;
    await send("Create an evidence box");
    await expect.element(page.getByRole("button", { name: ai.en.accept, exact: true })).toBeEnabled();
    await click(page.getByRole("button", { name: ai.en.accept, exact: true }));
    await waitForModraIdle();
    await expect.element(input()).toBeEnabled();
    const savedAfter = original.snapshot().document;
    expect(Object.keys(savedAfter.objects)).toHaveLength(1);
    await unmount();
    const before = (await repository.list(scope))[0]!;
    expect(before.state.changeSets[0]!.status).toBe("applied");
    expect(before.state.changeSets[0]!.evidence?.digest).toHaveLength(64);
    const requests = fetch.mock.calls.length;
    const reopened = new WorkspaceModelingHost(
      createProcessor(scene === "saved" ? savedAfter : savedBefore),
      scope,
      () => crypto.randomUUID(),
    );
    await mount(reopened);
    const recovered = (await repository.list(scope))[0]!;
    expect(recovered.state.changeSets[0]!.status).toBe("applied");
    expect(recovered.state.changeSets[0]!.effect).toBe(scene === "saved" ? "present" : "unknown");
    expect(reopened.processor.historyLength).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(Object.keys(reopened.snapshot().document.objects)).toHaveLength(scene === "saved" ? 1 : 0);
    // Same-scope replacements invalidate known effects as well as previews, never replaying them.
    await act(async () => reopened.replace(createProcessor(savedBefore), scope));
    await unmount();
    expect((await repository.list(scope))[0]!.state.changeSets[0]!.effect).toBe("unknown");
  },
);

test.each(["unavailable", "corrupt"] as const)(
  "%s local session storage leaves a usable memory session without overwriting data",
  async (code) => {
    const existing = await repository.create(scope, "Preserved record");
    const original = (await repository.load(existing.id))!;
    const fault = vi
      .spyOn(IndexedDBModraRepository.prototype, "sessionEntries")
      .mockRejectedValue(new ModraStorageError(code));
    const fetch = mockModelFetch().mockImplementation(async () => chatTextResponse("memory", "Available in memory"));
    await mount();
    await expect.element(page.getByText(ai.en.sessionMemory, { exact: true })).toBeVisible();
    await send("A memory-only request");
    await waitForModraIdle();
    await expect.element(input()).toBeEnabled();
    await expect.element(page.getByText("Available in memory", { exact: true })).toBeVisible();
    await unmount();
    fault.mockRestore();
    expect(await repository.load(existing.id)).toEqual(original);
    expect(await repository.list(scope)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  },
);
test.each([
  { width: 1440, language: "en", theme: "light" },
  { width: 1440, language: "zh-CN", theme: "dark" },
  { width: 768, language: "en", theme: "light" },
  { width: 390, language: "en", theme: "light" },
  { width: 390, language: "zh-CN", theme: "dark" },
] as const)(
  "session controls remain reachable without overflow at $width/$language/$theme",
  async ({ width, language, theme }) => {
    await initializeI18n(language);
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    await page.viewport(width, 844);
    const strings = ai[language];
    const record = await repository.create(
      scope,
      "An intentionally long session title that must not push local history controls outside the dialog",
    );
    await mount();
    await click(page.getByRole("button", { name: strings.sessions, exact: true }));
    const dialog = page.getByRole("dialog", { name: strings.sessions, exact: true });
    await expect.element(dialog.getByRole("button", { name: record.title, exact: true })).toBeVisible();
    const element = dialog.element();
    const bounds = element.getBoundingClientRect();
    expect(bounds.height).toBeCloseTo(560, 0);
    expect(bounds.left).toBeGreaterThanOrEqual(16);
    expect(bounds.right).toBeLessThanOrEqual(width - 16);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const list = dialog.getByTestId("modra-session-list").element();
    for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
      expect(getComputedStyle(list)[side]).toBe("0px");
    }
    const header = element.querySelector<HTMLElement>('[data-slot="dialog-header"]')!;
    expect(list.getBoundingClientRect().top).toBeCloseTo(header.getBoundingClientRect().bottom, 0);
    for (const row of list.children) expect(getComputedStyle(row).borderBottomWidth).toBe("0px");
    await click(
      dialog.getByRole("button", { name: strings.sessionRenameNamed.replace("{{name}}", record.title), exact: true }),
    );
    await expect.element(dialog.getByRole("textbox", { name: strings.sessionTitle })).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: language === "en" ? "Save" : "保存", exact: true }))
      .toBeVisible();
    expect(element.getBoundingClientRect().height).toBeCloseTo(bounds.height, 0);
    const rename = dialog.getByRole("textbox", { name: strings.sessionTitle }).element();
    await act(async () => rename.focus());
    await act(async () => userEvent.keyboard("{ArrowRight}"));
    expect(rename.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(rename).boxShadow).not.toBe("none");
    expect(getComputedStyle(rename).boxShadow).toContain("inset");
    expect(rename.getBoundingClientRect().left).toBeCloseTo(list.getBoundingClientRect().left, 0);
    expect(rename.getBoundingClientRect().top - list.getBoundingClientRect().top).toBeGreaterThanOrEqual(4);
    await click(dialog.getByRole("button", { name: strings.sessionCancel, exact: true }));
    await click(
      dialog.getByRole("button", { name: strings.sessionDeleteNamed.replace("{{name}}", record.title), exact: true }),
    );
    const confirmation = page.getByRole("dialog", { name: strings.sessionDeleteTitle, exact: true });
    expect(confirmation.element().scrollWidth).toBeLessThanOrEqual(confirmation.element().clientWidth);
    await expect
      .element(confirmation.getByRole("button", { name: strings.sessionDeleteConfirm, exact: true }))
      .toBeVisible();
    await click(confirmation.getByRole("button", { name: strings.sessionDeleteConfirm, exact: true }));
    await expect.element(dialog).not.toBeInTheDocument();
    await click(page.getByRole("button", { name: strings.sessions, exact: true }));
    await expect.element(dialog.getByRole("button", { name: record.title, exact: true })).not.toBeInTheDocument();
    const reopened = dialog.element();
    expect(reopened.getBoundingClientRect().height).toBeCloseTo(bounds.height, 0);
    await page.viewport(width, 400);
    expect(reopened.getBoundingClientRect().height).toBeCloseTo(368, 0);
    expect(reopened.getBoundingClientRect().top).toBeGreaterThanOrEqual(16);
  },
);

test("native and interchange scene exports exclude durable conversations, local images and stored credentials", async () => {
  const marker = "private-session-content-not-for-project-export";
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example/v1",
    modelId: "test-model",
    apiKey: "private-provider-key-not-for-export",
  });
  localStorage.setItem("test-gateway-secret", "private-gateway-token-not-for-export");
  mockModelFetch().mockImplementation(async () => chatTextResponse("private", marker));
  const modelingHost = await mount();
  await act(async () =>
    modelingHost.execute([{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }]),
  );
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), image()));
  await send(marker);
  await waitForModraIdle();
  await expect.element(input()).toBeEnabled();
  await act(async () => userEvent.fill(input(), "private-draft-not-for-export"));
  const document = modelingHost.snapshot().document;
  const outputs = [
    serializeNativeProject(document),
    (await exportGltf(document, "gltf")).data,
    (await exportGltf(document, "glb")).data,
  ];
  for (const output of outputs) {
    const text = typeof output === "string" ? output : new TextDecoder().decode(output);
    for (const secret of [
      marker,
      "private-provider-key-not-for-export",
      "private-gateway-token-not-for-export",
      "private-draft-not-for-export",
      "data:image/",
      "open-3d-modra",
    ])
      expect(text).not.toContain(secret);
  }
  await unmount();
  const [saved] = await repository.list(scope);
  expect(saved!.state.messages[0]!.assets).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain("private-provider-key-not-for-export");
  expect(JSON.stringify(saved)).not.toContain("private-gateway-token-not-for-export");
});

test.each(["en", "zh-CN"] as const)(
  "explicit object references remain previewable, durable and bounded in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language as keyof typeof ai];
    await repository.create(scope, "References");
    const modelingHost = host();
    modelingHost.execute([
      { commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Original box" } },
    ]);
    const id = modelingHost.snapshot().document.objects[0]!.id;
    modelingHost.execute([{ commandId: "selection.setObjects", arguments: { objectIds: [id] } }]);
    const fetchMock = mockModelFetch().mockResolvedValue(chatTextResponse("reference", "Observed reference"));
    await mount(modelingHost);
    await click(page.getByRole("button", { name: labels.mentionObject, exact: true }));
    await click(page.getByRole("button", { name: labels.attachSelection, exact: true }));
    await expect.element(page.getByRole("dialog", { name: labels.mentionObject, exact: true })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".ai-prompt-form [data-object-reference]")).toHaveLength(1);
    await fill(page.getByRole("textbox", { name: labels.message, exact: true }), "Inspect the box");
    await expect.poll(async () => (await repository.list(scope))[0]?.draft.references?.[0]?.id).toBe(id);
    await unmount();
    await mount(modelingHost);
    await expect
      .element(page.getByRole("textbox", { name: labels.message, exact: true }))
      .toHaveValue("Inspect the box");
    expect(document.querySelectorAll(".ai-prompt-form [data-object-reference]")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () =>
      modelingHost.execute([{ commandId: "object.rename", arguments: { objectId: id, name: "Current box" } }]),
    );
    await click(page.getByRole("button", { name: labels.send, exact: true }));
    await expect.element(page.getByText("Observed reference", { exact: true })).toBeInTheDocument();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(JSON.stringify(body.messages)).toContain("currentName");
    expect(JSON.stringify(body.messages)).toContain("Current box");
    expect(JSON.stringify(body.messages)).not.toContain("vertexIds");
    const chip = document.querySelector<HTMLElement>(".ai-message [data-object-reference]")!;
    expect(chip.textContent).toContain("Current box");
    expect(chip.title).toContain("Original box");
    expect(chip.title).toContain("v3");
  },
);

test.each(["missing", "replaced"])("%s object references cannot silently bind to a same-name object", async (kind) => {
  const modelingHost = host();
  modelingHost.execute([{ commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Same name" } }]);
  const id = modelingHost.snapshot().document.objects[0]!.id;
  const fetchMock = mockModelFetch();
  await mount(modelingHost);
  await click(page.getByRole("button", { name: ai.en.mentionObject, exact: true }));
  await click(
    page
      .getByRole("dialog", { name: ai.en.mentionObject, exact: true })
      .getByRole("button", { name: "Same name", exact: true }),
  );
  await act(async () => {
    if (kind === "missing")
      modelingHost.execute([
        { commandId: "object.delete", arguments: { objectIds: [id] } },
        { commandId: "scene.createPrimitive", arguments: { primitive: "box", name: "Same name" } },
      ]);
    else modelingHost.replace(createProcessor(modelingHost.snapshot().document), scope);
  });
  await send("Inspect reference");
  await expect.element(page.getByText(ai.en.contextReferenceError, { exact: true })).toBeInTheDocument();
  await expect.element(input()).toHaveValue("Inspect reference");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.querySelectorAll(".ai-prompt-form [data-object-reference]")).toHaveLength(1);
  await click(page.getByRole("button", { name: "Remove reference to Same name", exact: true }));
  expect(document.querySelectorAll(".ai-prompt-form [data-object-reference]")).toHaveLength(0);
});
test.each(["en", "zh-CN"] as const)(
  "viewport captures are explicit bounded images without scene mutation in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language];
    const { ThreeViewport } = await import("@open-3d/viewport-three");
    const modelingHost = host();
    modelingHost.execute([{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }]);
    const viewHost = document.createElement("div");
    viewHost.style.cssText = "width:1500px;height:800px";
    container.append(viewHost);
    const viewport = new ThreeViewport();
    viewport.mount(viewHost);
    viewport.setDocument(modelingHost.snapshot().document);
    modelingHost.setViewportCapture(() => viewport.capture());
    const before = modelingHost.snapshot();
    const canvas = viewHost.querySelector("canvas");
    const fetchMock = mockModelFetch().mockResolvedValue(chatTextResponse("capture", "Captured context"));
    try {
      await mount(modelingHost);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(0);
      const blob = await viewport.capture();
      const bitmap = await createImageBitmap(blob);
      expect(Math.max(bitmap.width, bitmap.height)).toBe(1024);
      expect(blob.type).toBe("image/jpeg");
      expect(blob.size).toBeLessThanOrEqual(5 * 1024 * 1024);
      bitmap.close();
      await click(page.getByRole("button", { name: labels.captureViewport, exact: true }));
      await expect.poll(() => document.querySelectorAll(".ai-prompt-form img").length).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(modelingHost.snapshot()).toEqual(before);
      expect(viewHost.querySelector("canvas")).toBe(canvas);
      await click(page.getByRole("button", { name: labels.send, exact: true }));
      await expect.element(page.getByText("Captured context", { exact: true })).toBeInTheDocument();
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(JSON.stringify(body.messages)).toContain("data:image/jpeg;base64,");
      expect(modelingHost.snapshot()).toEqual(before);
      // No overflow or clipped toolbar at the narrow composer width.
      const form = document.querySelector<HTMLElement>(".ai-prompt-form")!;
      expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
    } finally {
      viewport.dispose();
      viewHost.remove();
    }
  },
);

test("unavailable, tainted and oversized captures keep drafts and scene intact; five images block more capture", async () => {
  const modelingHost = await mount();
  const before = modelingHost.snapshot();
  const fetchMock = mockModelFetch();
  await fill(input(), "Keep this draft");
  const capture = () => page.getByRole("button", { name: ai.en.captureViewport, exact: true });
  await click(capture());
  await expect.element(page.getByText(ai.en.captureViewportError, { exact: true })).toBeInTheDocument();
  modelingHost.setViewportCapture(async () => {
    throw new DOMException("Tainted", "SecurityError");
  });
  await click(capture());
  await expect.element(page.getByText(ai.en.captureViewportError, { exact: true })).toBeInTheDocument();
  modelingHost.setViewportCapture(async () => new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/jpeg" }));
  await click(capture());
  await expect.element(page.getByText(ai.en.imageSizeError, { exact: true })).toBeInTheDocument();
  const imageBlob = image();
  const captureMock = vi.fn(async () => imageBlob);
  modelingHost.setViewportCapture(captureMock);
  for (let i = 1; i <= 5; i++) {
    await click(capture());
    await expect.poll(() => document.querySelectorAll(".ai-prompt-form img").length).toBe(i);
  }
  await expect.element(capture()).toBeDisabled();
  expect(captureMock).toHaveBeenCalledTimes(5);
  await expect.element(page.getByRole("button", { name: ai.en.addImages, exact: true })).toBeDisabled();
  expect(fetchMock).not.toHaveBeenCalled();
  await expect.element(input()).toHaveValue("Keep this draft");
  expect(modelingHost.snapshot()).toEqual(before);
});
test.each(["en", "zh-CN"] as const)(
  "Plan and approval are independent; Build from plan uses fresh scene in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language];
    const requests: Record<string, any>[] = [];
    const fetchMock = mockModelFetch().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      if (requests.length === 1)
        return chatToolCallResponse("plan", "update_task_plan", {
          steps: [{ id: "box", label: "Build the main box", status: "pending" }],
        });
      if (requests.length === 2) return chatTextResponse("planned", "Plan ready");
      if (requests.length === 3)
        return chatToolCallResponse("build", "command_scene_createPrimitive", {
          primitive: "box",
          name: "Planned box",
        });
      return chatTextResponse("review", "Review this batch");
    });
    const modelingHost = await mount();
    const before = modelingHost.snapshot();
    await click(page.getByRole("button", { name: labels.taskMode, exact: true }));
    await click(page.getByRole("menuitemradio", { name: labels.planMode, exact: true }));
    await click(page.getByRole("button", { name: labels.approvalMode, exact: true }));
    await click(page.getByRole("menuitemradio", { name: labels.autoApproval, exact: true }));
    await fill(page.getByRole("textbox", { name: labels.message, exact: true }), "Plan a box");
    await click(page.getByRole("button", { name: labels.send, exact: true }));
    await expect.element(page.getByText("Plan ready", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: labels.buildFromPlan, exact: true })).toBeEnabled();
    expect(modelingHost.snapshot()).toEqual(before);
    expect(requests[0]!.tools.some((tool: any) => tool.function.name.startsWith("command_"))).toBe(false);
    expect(requests[0]!.tools.some((tool: any) => tool.function.name === "update_task_plan")).toBe(true);
    expect(document.querySelector("[data-plan-step=box]")!.textContent).toContain(labels.planStatus.pending);
    await act(async () => modelingHost.execute([{ commandId: "document.rename", arguments: { name: "Fresh scene" } }]));
    await click(page.getByRole("button", { name: labels.approvalMode, exact: true }));
    await click(page.getByRole("menuitemradio", { name: labels.requestApproval, exact: true }));
    await click(page.getByRole("button", { name: labels.buildFromPlan, exact: true }));
    await expect.element(page.getByText("Review this batch", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: labels.accept, exact: true })).toBeEnabled();
    expect(modelingHost.snapshot().document.objects).toHaveLength(0);
    await click(page.getByText(labels.affectedObjects.replace("{{count}}", "1"), { exact: true }));
    expect(document.querySelector("[data-affected-object=object-1]")!.textContent).toContain("Planned box");
    expect(document.querySelector("[data-affected-object=object-1]")!.textContent).toContain(
      labels.objectChange.created,
    );
    await expect.element(page.getByText(labels.wholeBatchReview, { exact: true })).toBeInTheDocument();
    expect(JSON.stringify(requests[2]!.messages)).toContain('mutationVersion\\\":1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  },
);
test.each(["en", "zh-CN"] as const)(
  "editable composer queues immutable FIFO text and images during generation in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language];
    document.documentElement.classList.toggle("dark", language === "zh-CN");
    document.documentElement.dataset.theme = language === "zh-CN" ? "dark" : "light";
    const stream = controlledChatResponse();
    const requests: string[] = [];
    const fetchMock = mockModelFetch().mockImplementation(async (_url, init) => {
      requests.push(init!.body as string);
      return requests.length === 1
        ? stream.response
        : chatTextResponse(`queue-${requests.length}`, `Answer ${requests.length}`);
    });
    await mount();
    const textbox = page.getByRole("textbox", { name: labels.message, exact: true });
    await fill(textbox, "First task");
    await click(page.getByRole("button", { name: labels.send, exact: true }));
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    await expect.element(textbox).toBeEnabled();
    await act(async () => stream.text("Working"));
    await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), image()));
    await fill(textbox, "Second task with image");
    await act(async () => userEvent.keyboard("{Enter}"));
    await expect.poll(() => document.querySelectorAll("[data-queued-task]").length).toBe(1);
    await fill(textbox, "Third task");
    await click(page.getByRole("button", { name: labels.queuePrompt, exact: true }));
    await fill(textbox, "A newer draft must remain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-queued-task]")).toHaveLength(2);
    expect(document.querySelector(".ai-conversation")!.scrollWidth).toBeLessThanOrEqual(
      document.querySelector(".ai-conversation")!.clientWidth,
    );
    await act(async () => stream.finish());
    await expect.element(page.getByText("Answer 3", { exact: true })).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll("[data-queued-task]").length).toBe(0);
    expect(requests[1]).toContain("Second task with image");
    expect(requests[1]).toContain("data:image/png;base64,");
    expect(requests[2]).toContain("Third task");
    await expect.element(textbox).toHaveValue("A newer draft must remain");
  },
);

test("failed partial review pauses queued corrections through Keep, requiring explicit resume", async () => {
  const stream = controlledChatResponse();
  let calls = 0;
  const fetchMock = mockModelFetch().mockImplementation(async () => {
    calls++;
    if (calls === 1)
      return chatToolCallResponse("partial-queued", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Partial queued box",
      });
    if (calls === 2) return stream.response;
    return chatTextResponse("queue-resumed", "Correction received");
  });
  const modelingHost = await mount();
  await send("Create a box");
  await expect.poll(() => calls).toBe(2);
  await fill(input(), "Correction after review");
  await click(page.getByRole("button", { name: ai.en.queuePrompt, exact: true }));
  await act(async () => stream.fail());
  await expect.element(page.getByRole("button", { name: ai.en.keepChanges, exact: true })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: ai.en.resumeQueue, exact: true })).toBeDisabled();
  await click(page.getByRole("button", { name: ai.en.keepChanges, exact: true }));
  await expect.element(page.getByRole("button", { name: ai.en.resumeQueue, exact: true })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(modelingHost.snapshot().document.objects).toHaveLength(1);
  await click(page.getByRole("button", { name: ai.en.resumeQueue, exact: true }));
  await expect.element(page.getByText("Correction received", { exact: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("cancel and reload retain paused queue assets; reopening never uploads and explicit resume restores them", async () => {
  const stream = controlledChatResponse();
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(stream.response)
    .mockResolvedValue(chatTextResponse("resume-image", "Stored image received"));
  const modelingHost = await mount();
  await send("Original");
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), image()));
  await fill(input(), "Queued durable image");
  await click(page.getByRole("button", { name: ai.en.queuePrompt, exact: true }));
  await click(page.getByRole("button", { name: ai.en.cancelRequest, exact: true }));
  await unmount();
  await mount(modelingHost);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-queued-task]")).toHaveLength(1);
  await click(page.getByRole("button", { name: ai.en.resumeQueue, exact: true }));
  await expect.element(page.getByText("Stored image received", { exact: true })).toBeInTheDocument();
  expect(fetchMock.mock.calls[1]![1]!.body).toContain("data:image/png;base64,");
});

test("queued references are revalidated after manual deletion before any new request and entries are removable", async () => {
  const stream = controlledChatResponse();
  const fetchMock = mockModelFetch().mockResolvedValueOnce(stream.response);
  const modelingHost = host();
  modelingHost.execute([{ commandId: "scene.createPrimitive", arguments: { primitive: "box" } }]);
  const id = modelingHost.snapshot().document.objects[0]!.id;
  modelingHost.execute([{ commandId: "selection.setObjects", arguments: { objectIds: [id] } }]);
  await mount(modelingHost);
  await send("Original");
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  await click(page.getByRole("button", { name: ai.en.mentionObject, exact: true }));
  await click(page.getByRole("button", { name: ai.en.attachSelection, exact: true }));
  await expect.element(page.getByRole("dialog", { name: ai.en.mentionObject, exact: true })).not.toBeInTheDocument();
  await fill(input(), "Inspect queued box");
  await click(page.getByRole("button", { name: ai.en.queuePrompt, exact: true }));
  await act(async () => modelingHost.execute([{ commandId: "object.delete", arguments: { objectIds: [id] } }]));
  await expect.element(page.getByRole("button", { name: ai.en.resumeQueue, exact: true })).toBeEnabled();
  await click(page.getByRole("button", { name: ai.en.resumeQueue, exact: true }));
  await expect.element(page.getByText(ai.en.contextReferenceError, { exact: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click(page.getByRole("button", { name: "Remove queued prompt: Inspect queued box", exact: true }));
  await expect.poll(() => document.querySelectorAll("[data-queued-task]").length).toBe(0);
});
test.each(["en", "zh-CN"] as const)(
  "context and output errors preserve transcript with actionable guidance in %s",
  async (language) => {
    await initializeI18n(language);
    const labels = ai[language];
    mockModelFetch().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "context length exceeded" } }), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    );
    const modelingHost = await mount();
    const before = modelingHost.snapshot();
    await fill(page.getByRole("textbox", { name: labels.message, exact: true }), "Preserve my instructions");
    await click(page.getByRole("button", { name: labels.send, exact: true }));
    await expect.element(page.getByText(labels.contextLimitError, { exact: true })).toBeInTheDocument();
    await expect
      .element(
        page.getByLabelText(labels.messages, { exact: true }).getByText("Preserve my instructions", { exact: true }),
      )
      .toBeInTheDocument();
    expect(modelingHost.snapshot()).toEqual(before);
    await click(page.getByRole("button", { name: labels.sessions, exact: true }));
    await expect.element(page.getByRole("button", { name: labels.sessionCreate, exact: true })).toBeEnabled();
  },
);

test("automatic session titles persist and never replace a manual title on later requests", async () => {
  const fetch = mockModelFetch().mockImplementation(async () => chatTextResponse("title", "Ready"));
  await mount();
  await send("Build a reading lamp");
  await waitForModraIdle();
  const record = (await repository.list(scope))[0]!;
  await expect.poll(async () => (await repository.list(scope))[0]?.title).toBe("Modeling");
  record.title = "Modeling";
  await expect.element(page.getByRole("button", { name: ai.en.sessions, exact: true })).toHaveTextContent(record.title);
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: `Rename ${record.title}`, exact: true }));
  await fill(page.getByRole("textbox", { name: ai.en.sessionTitle }), "Untitled session");
  await click(page.getByRole("button", { name: ai.en.sessionRenameSave }));
  await expect.element(page.getByRole("button", { name: "Rename Untitled s", exact: true })).toBeVisible();
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(page.getByRole("dialog", { name: ai.en.sessions, exact: true })).not.toBeInTheDocument();
  await send("Change the shade");
  await waitForModraIdle();
  await unmount();
  expect((await repository.load(record.id))!.title).toBe("Untitled s");
  await mount();
  await expect.element(page.getByRole("button", { name: ai.en.sessions, exact: true })).toHaveTextContent("Untitled s");
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("persists actual text-tool-proposal-text order across session reload", async () => {
  const fetch = mockModelFetch()
    .mockImplementationOnce(async () => {
      const text = await chatTextResponse("ordered", "I will create a box.").text();
      const tool = await chatToolCallResponse("ordered", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Ordered box",
      }).text();
      return new Response(text.split("\n\n")[0] + "\n\n" + tool, { headers: { "content-type": "text/event-stream" } });
    })
    .mockImplementation(async () => chatTextResponse("ordered-final", "The preview is ready."));
  await mount();
  await send("Build an ordered box");
  await waitForModraIdle();
  const order = () =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-message-part]")).map((part) => part.dataset.messagePart);
  expect(order()).toEqual(["text", "tool", "changes", "text"]);
  const before = order();
  await unmount();
  const records = await repository.list(scope);
  expect(records[0]!.state.messages.at(-1)!.parts?.map((part) => part.type)).toEqual(before);
  await mount();
  expect(order()).toEqual(before);
  expect(container.querySelectorAll("[data-ai-proposals] li")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([390, 1440])(
  "aligns session editing and layers deletion confirmation above its parent at %spx",
  async (width) => {
    await page.viewport(width, 844);
    await mount();
    await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
    const manager = page.getByRole("dialog", { name: ai.en.sessions, exact: true });
    const header = manager.element().querySelector('[data-slot="dialog-header"]')!;
    expect(header.contains(manager.getByRole("button", { name: ai.en.sessionCreate, exact: true }).element())).toBe(
      true,
    );
    const close = manager.getByRole("button", { name: ai.en.closeSessions, exact: true });
    expect(header.contains(close.element())).toBe(true);
    await click(manager.getByRole("button", { name: /^Rename / }));
    const inputBounds = manager.getByRole("textbox", { name: ai.en.sessionTitle }).element().getBoundingClientRect();
    for (const name of [ai.en.sessionRenameSave, ai.en.sessionCancel]) {
      const bounds = manager.getByRole("button", { name, exact: true }).element().getBoundingClientRect();
      expect(bounds.top).toBeCloseTo(inputBounds.top, 0);
      expect(bounds.height).toBeCloseTo(inputBounds.height, 0);
      expect(bounds.right).toBeLessThanOrEqual(manager.element().getBoundingClientRect().right);
    }
    await click(manager.getByRole("button", { name: ai.en.sessionCancel, exact: true }));
    const managerNode = manager.element();
    await click(manager.getByRole("button", { name: /^Delete / }));
    const confirm = page.getByRole("dialog", { name: ai.en.sessionDeleteTitle, exact: true });
    await expect.element(confirm).toBeVisible();
    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"].z-\\[1002\\]')!;
    expect(backdrop).not.toBeNull();
    expect(Number(getComputedStyle(backdrop).zIndex)).toBeGreaterThan(Number(getComputedStyle(managerNode).zIndex));
    expect(Number(getComputedStyle(backdrop).zIndex)).toBeLessThan(Number(getComputedStyle(confirm.element()).zIndex));
    const bounds = managerNode.getBoundingClientRect();
    expect(document.elementsFromPoint(bounds.left + 3, bounds.top + 3).indexOf(backdrop)).toBeLessThan(
      document.elementsFromPoint(bounds.left + 3, bounds.top + 3).indexOf(managerNode),
    );
    await click(confirm.getByRole("button", { name: ai.en.sessionCancel, exact: true }));
    await expect.element(manager).toBeVisible();
    await click(close);
    await expect.element(manager).not.toBeInTheDocument();
  },
);

test.each(["en", "zh-CN"] as const)("sizes mode menus to their labels in %s", async (language) => {
  await initializeI18n(language);
  await mount();
  const labels = ai[language];
  for (const label of [labels.taskMode, labels.approvalMode]) {
    await click(page.getByRole("button", { name: label, exact: true }));
    const menu = page.getByRole("menu", { name: label, exact: true });
    await expect.element(menu).toBeVisible();
    const bounds = menu.element().getBoundingClientRect();
    const items = menu.element().querySelectorAll('[role="menuitemradio"]');
    const widest = Math.max(
      ...Array.from(items, (item) => {
        const range = document.createRange();
        range.selectNodeContents(item.firstChild!);
        return range.getBoundingClientRect().width;
      }),
    );
    expect(bounds.width - widest).toBeLessThan(60);
    await act(async () => userEvent.keyboard("{Escape}"));
  }
});
test("first reply generates a short title independently, persists message times and never replays naming on reload", async () => {
  const reply = controlledChatResponse("reply");
  const title = controlledChatResponse("title");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(reply.response)
    .mockResolvedValueOnce(title.response);
  await mount();
  await send("Build a reading lamp with a wide shade");
  await expect.element(page.getByRole("button", { name: ai.en.sessions, exact: true })).toHaveTextContent("Build a re");
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => {
    reply.text("The lamp is ready.");
    reply.finish();
  });
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  const body = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  expect(body.tools).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("data:image");
  await act(async () => {
    title.text("阅读台灯设计");
    title.finish();
  });
  await expect
    .element(page.getByRole("button", { name: ai.en.sessions, exact: true }))
    .toHaveTextContent("阅读台灯设计");
  const times = Array.from(container.querySelectorAll<HTMLTimeElement>(".ai-message time"));
  expect(times).toHaveLength(2);
  expect(times.every((time) => Number.isFinite(Date.parse(time.dateTime)))).toBe(true);
  for (const header of container.querySelectorAll(".ai-message-header")) {
    const copy = header.querySelector("button")!;
    expect(copy.getBoundingClientRect().height).toBe(24);
    expect(Math.abs(copy.getBoundingClientRect().top - header.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
  }
  const datetimes = times.map((time) => time.dateTime);
  await unmount();
  await mount();
  expect(Array.from(container.querySelectorAll<HTMLTimeElement>("time")).map((time) => time.dateTime)).toEqual(
    datetimes,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("a late AI title cannot replace a manually renamed session", async () => {
  const title = controlledChatResponse("late-title");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(chatTextResponse("reply", "Ready"))
    .mockResolvedValueOnce(title.response);
  await mount();
  await send("Build a reading lamp");
  await waitForModraIdle();
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: /^Rename / }));
  await fill(page.getByRole("textbox", { name: ai.en.sessionTitle }), "我的台灯设计");
  await click(page.getByRole("button", { name: ai.en.sessionRenameSave }));
  await act(async () => {
    title.text("AI自动名称");
    title.finish();
  });
  await click(page.getByRole("button", { name: ai.en.closeSessions, exact: true }));
  await expect.element(page.getByRole("dialog", { name: ai.en.sessions, exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: ai.en.sessions, exact: true }))
    .toHaveTextContent("我的台灯设计");
  await unmount();
  expect((await repository.list(scope))[0]!.titleSource).toBe("manual");
  expect((await repository.list(scope))[0]!.title).toBe("我的台灯设计");
});

test("failed title generation leaves the provisional title and modeling reply intact", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(chatTextResponse("reply", "Your lamp is ready."))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await mount();
  await send("Build a reading lamp");
  await waitForModraIdle();
  await expect.element(page.getByRole("button", { name: ai.en.sessions, exact: true })).toHaveTextContent("Build a re");
  await expect.element(page.getByText("Your lamp is ready.", { exact: true })).toBeVisible();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
test("switching sessions aborts pending title generation and keeps each session title isolated", async () => {
  const title = controlledChatResponse("pending-title");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(chatTextResponse("reply", "Ready"))
    .mockResolvedValueOnce(title.response);
  await mount();
  await send("Build a reading lamp");
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  const signal = fetch.mock.calls[1]![1]!.signal!;
  await waitForModraIdle();
  const original = (await repository.list(scope))[0]!;
  await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
  await click(page.getByRole("button", { name: ai.en.sessionCreate, exact: true }));
  await expect.poll(() => signal.aborted).toBe(true);
  expect((await repository.load(original.id))!.title).toBe("Build a re");
  expect(await repository.list(scope)).toHaveLength(1);
  await expect
    .element(page.getByRole("button", { name: ai.en.sessions, exact: true }))
    .toHaveTextContent(ai.en.sessionUntitled);
  expect(fetch).toHaveBeenCalledTimes(2);
});