import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { ModraTranscript } from "../src/modra/components/transcript";
import { TRANSCRIPT_BOTTOM_THRESHOLD, transcriptBottomDistance } from "../src/modra/components/use-transcript-scroll";
import type { ConversationMessage } from "../src/workspace/ai-conversation-message";
import "../src/style.css";

let root: Root;
let container: HTMLDivElement;
let messages: ConversationMessage[];
let active: boolean;
let busy: boolean;
const lines = (count: number) => Array.from({ length: count }, (_, i) => `Modeling detail ${i}`).join("\n");
const frames = async () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
const viewport = () => container.querySelector<HTMLDivElement>(".ai-transcript")!;
const distance = () => transcriptBottomDistance(viewport());

async function render() {
  await act(async () =>
    root.render(
      <div style={{ display: active ? "flex" : "none", height: 320, flexDirection: "column", overflowY: "auto" }}>
        <ModraTranscript
          active={active}
          messages={messages}
          isBusy={busy}
          activeAssistantMessageId="reply"
          acceptProposal={() => {}}
          rejectProposal={() => {}}
        />
      </div>,
    ),
  );
  await frames();
}

async function scrollGap(gap: number) {
  await act(async () => {
    const node = viewport();
    node.scrollTop = node.scrollHeight - node.clientHeight - gap;
    node.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await frames();
}

async function grow(count = 100) {
  messages = messages.map((message) => ({ ...message, text: `${message.text}\n${lines(count)}` }));
  await render();
}

beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  container = document.createElement("div");
  container.style.width = "390px";
  document.body.append(container);
  root = createRoot(container);
  active = true;
  busy = true;
  messages = [{ id: "reply", role: "assistant", text: lines(100) }];
  await render();
  await expect.poll(distance).toBe(0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});

test.each([390, 768, 1440])(
  "copy feedback stays inside a scrolling transcript without outer overflow at %i",
  async (width) => {
    await page.viewport(width, 900);
    container.style.width = `${Math.min(width - 40, 420)}px`;
    busy = false;
    messages = [
      { id: "long", role: "user", text: lines(100) },
      { id: "reply", role: "assistant", text: "Finished modeling" },
    ];
    await render();
    await expect.poll(distance).toBe(0);
    const outer = viewport().parentElement!.parentElement!;
    const before = { outer: outer.scrollHeight, transcript: viewport().scrollHeight, top: viewport().scrollTop };
    expect(before.outer).toBe(outer.clientHeight);
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const copy = page.getByRole("button", { name: "Copy message", exact: true }).last();
    for (const failed of [false, true]) {
      if (failed) write.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
      await act(async () => userEvent.click(copy));
      await frames();
      expect(write).toHaveBeenLastCalledWith("Finished modeling");
      expect(container.querySelector('[role="status"]')?.textContent).toBe(failed ? ai.en.copyFailed : ai.en.copied);
      expect(outer.scrollHeight).toBe(before.outer);
      expect(viewport().scrollHeight).toBe(before.transcript);
      expect(viewport().scrollTop).toBe(before.top);
    }
  },
);

test("follows large deltas at exactly 80px but preserves a reader beyond the threshold", async () => {
  expect(TRANSCRIPT_BOTTOM_THRESHOLD).toBe(80);
  await scrollGap(80);
  await grow();
  await expect.poll(distance).toBe(0);
  await scrollGap(81);
  const top = viewport().scrollTop;
  await grow();
  expect(viewport().scrollTop).toBe(top);
  await expect.element(page.getByRole("button", { name: "Return to bottom", exact: true })).toBeVisible();
  await scrollGap(79);
  await grow();
  await expect.poll(distance).toBe(0);
});

test("upward keyboard and native wheel scrolling suspend following", async () => {
  viewport().focus();
  await act(async () => userEvent.keyboard("{Home}"));
  await expect.poll(() => viewport().scrollTop).toBe(0);
  await grow();
  expect(viewport().scrollTop).toBe(0);
  await act(async () => userEvent.click(page.getByRole("button", { name: "Return to bottom" })));
  await expect.poll(distance).toBe(0);
  const rect = viewport().getBoundingClientRect();
  const session = cdp();
  const { result } = await session.send("Runtime.evaluate", {
    expression:
      'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
    returnByValue: true,
  });
  const offset = JSON.parse(result.value as string) as { x: number; y: number };
  await act(async () =>
    session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: rect.x + offset.x + 20,
      y: rect.y + offset.y + 20,
      deltaX: 0,
      deltaY: -240,
    }),
  );
  await expect.poll(distance).toBeGreaterThan(80);
  const top = viewport().scrollTop;
  await grow();
  expect(viewport().scrollTop).toBe(top);
});

test("suspended reading survives tools, image growth, resizing, terminal state and reopen", async () => {
  await scrollGap(180);
  const top = viewport().scrollTop;
  messages = [
    ...messages,
    {
      id: "tool",
      role: "assistant",
      text: "Inspect scene",
      toolCalls: [{ id: "query", name: "query_scene", status: "completed", input: {}, output: { objects: lines(40) } }],
      images: [
        {
          id: "image",
          name: "Reference",
          mediaType: "image/svg+xml",
          dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"></svg>',
        },
      ],
    },
  ];
  await render();
  expect(viewport().scrollTop).toBe(top);
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
  });
  await frames();
  expect(viewport().scrollTop).toBe(top);
  container.style.width = "270px";
  await frames();
  expect(viewport().scrollTop).toBe(top);
  busy = false;
  await render();
  expect(viewport().scrollTop).toBe(top);
  active = false;
  await render();
  await grow();
  active = true;
  await render();
  expect(viewport().scrollTop).toBe(top);
  await expect.element(page.getByRole("button", { name: "Return to bottom" })).toBeVisible();
});

test.each(["en", "zh-CN"] as const)(
  "return button restores following without stealing pointer focus in %s",
  async (language) => {
    await initializeI18n(language);
    await scrollGap(250);
    const button = page.getByRole("button", { name: language === "en" ? "Return to bottom" : "返回底部", exact: true });
    viewport().focus();
    await act(async () => userEvent.click(button));
    expect(document.activeElement).toBe(viewport());
    await expect.poll(distance).toBe(0);
    await grow();
    expect(distance()).toBe(0);
    await scrollGap(200);
    (button.element() as HTMLButtonElement).focus();
    await act(async () => userEvent.keyboard("{Enter}"));
    expect(document.activeElement).toBe(viewport());
    expect(getComputedStyle(viewport()).scrollBehavior).toBe("auto");
    await expect.element(button).not.toBeInTheDocument();
  },
);

test("message padding separates consecutive messages without an outer gap", async () => {
  messages = [
    { id: "user", role: "user", text: "Build a lamp" },
    { id: "reply", role: "assistant", text: "Checking the proportions" },
  ];
  await render();
  const rows = container.querySelectorAll<HTMLElement>(".ai-message");
  expect(rows[1].getBoundingClientRect().top).toBeCloseTo(rows[0].getBoundingClientRect().bottom, 0);
});

test("returning animates through intermediate positions and follows streaming content", async () => {
  await scrollGap(1400);
  const start = viewport().scrollTop;
  await act(async () =>
    (page.getByRole("button", { name: "Return to bottom" }).element() as HTMLButtonElement).click(),
  );
  await frames();
  expect(viewport().scrollTop).toBeGreaterThan(start);
  expect(distance()).toBeGreaterThan(0);
  await grow(20);
  await expect.poll(distance).toBe(0);
  await grow(20);
  expect(distance()).toBe(0);
});

test("manual scrolling interrupts the smooth return and preserves the reading position", async () => {
  await scrollGap(1400);
  await act(async () =>
    (page.getByRole("button", { name: "Return to bottom" }).element() as HTMLButtonElement).click(),
  );
  await frames();
  await act(async () => {
    viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    viewport().scrollTop -= 120;
    viewport().dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  const top = viewport().scrollTop;
  await grow(20);
  expect(viewport().scrollTop).toBe(top);
  await expect.element(page.getByRole("button", { name: "Return to bottom" })).toBeVisible();
});

test("layout clamping near the bottom does not implicitly resume a suspended reader", async () => {
  await scrollGap(90);
  messages = messages.map((message) => ({ ...message, text: lines(98) }));
  await render();
  const top = viewport().scrollTop;
  await grow();
  expect(viewport().scrollTop).toBe(top);
});

test("native touch scrolling suspends following and reduced motion keeps the return instant", async () => {
  const session = cdp();
  const { result } = await session.send("Runtime.evaluate", {
    expression:
      'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
    returnByValue: true,
  });
  const offset = JSON.parse(result.value as string) as { x: number; y: number };
  const rect = viewport().getBoundingClientRect();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await act(async () =>
      session.send("Input.synthesizeScrollGesture", {
        x: rect.x + offset.x + 30,
        y: rect.y + offset.y + 30,
        yDistance: 200,
        xDistance: 0,
        speed: 600,
        gestureSourceType: "touch",
      }),
    );
    await expect.poll(distance).toBeGreaterThan(80);
    const top = viewport().scrollTop;
    await grow();
    expect(viewport().scrollTop).toBe(top);
    const button = page.getByRole("button", { name: "Return to bottom" });
    const bounds = button.element().getBoundingClientRect();
    expect(bounds.height).toBe(32);
    const transcript = viewport().getBoundingClientRect();
    expect(bounds.top).toBeGreaterThan(transcript.top);
    expect(bounds.bottom).toBeLessThanOrEqual(transcript.bottom);
    expect(getComputedStyle(viewport().parentElement!).paddingBottom).toBe("0px");
    await act(async () => userEvent.click(button));
    expect(distance()).toBe(0);
    expect(getComputedStyle(viewport()).scrollBehavior).toBe("auto");
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("centers a compact return button and swaps streaming spinner for a hover arrow", async () => {
  await scrollGap(180);
  await userEvent.hover(page.getByLabelText("Conversation messages", { exact: true }));
  const button = page.getByRole("button", { name: "Return to bottom", exact: true });
  await expect.element(button).toBeVisible();
  const bounds = button.element().getBoundingClientRect();
  const transcript = viewport().getBoundingClientRect();
  expect(bounds.width).toBe(32);
  expect(bounds.height).toBe(32);
  expect(bounds.x + bounds.width / 2).toBeCloseTo(transcript.x + transcript.width / 2, 0);
  const spinner = button.element().querySelector("[data-return-loading]")!;
  const arrow = button.element().querySelector(".lucide-arrow-down")!;
  expect(getComputedStyle(spinner).display).not.toBe("none");
  expect(getComputedStyle(arrow).display).toBe("none");
  await userEvent.hover(button);
  expect(getComputedStyle(spinner).display).toBe("none");
  expect(getComputedStyle(arrow).display).not.toBe("none");
  busy = false;
  await render();
  expect(button.element().querySelector("[data-return-loading]")).toBeNull();
  expect(getComputedStyle(button.element().querySelector(".lucide-arrow-down")!).display).not.toBe("none");
});
test("renders alternating text, tools and suggestions in response order with one whole-batch review", async () => {
  busy = false;
  messages = [
    {
      id: "reply",
      role: "assistant",
      text: "BeforeAfterReady",
      parts: [
        { type: "text", start: 0, end: 6 },
        { type: "tool", id: "first" },
        { type: "text", start: 6, end: 11 },
        { type: "changes", start: 0, end: 1 },
        { type: "tool", id: "second" },
        { type: "changes", start: 1, end: 2 },
        { type: "text", start: 11, end: 16 },
      ],
      toolCalls: [
        { id: "first", name: "query_scene", status: "completed" },
        { id: "second", name: "create_primitive", status: "completed" },
      ],
      proposals: [
        { commandId: "scene.createPrimitive", arguments: { name: "First box" } },
        { commandId: "scene.createPrimitive", arguments: { name: "Second box" } },
      ],
      proposalReady: true,
      proposalStatus: "pending",
    },
  ];
  await render();
  const parts = Array.from(container.querySelectorAll<HTMLElement>("[data-message-part]"));
  expect(parts.map((node) => node.dataset.messagePart)).toEqual([
    "text",
    "tool",
    "text",
    "changes",
    "tool",
    "changes",
    "text",
  ]);
  expect(parts[0]!.textContent).toBe("Before");
  expect(parts[2]!.textContent).toBe("After");
  expect(parts[3]!.textContent).toContain("First box");
  expect(parts[5]!.textContent).toContain("Second box");
  expect(parts[6]!.textContent).toBe("Ready");
  await frames();
  expect(container.querySelectorAll("[data-ai-proposals] li")).toHaveLength(2);
  expect(container.querySelectorAll("[data-ai-tool-call]")).toHaveLength(2);
  expect(page.getByRole("button", { name: "Accept changes", exact: true }).elements()).toHaveLength(1);
});