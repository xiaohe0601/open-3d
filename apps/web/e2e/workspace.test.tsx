import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import {
  createLocalProjectStore,
  LocalProjectStorageError,
  LOCAL_PROJECTS_DATABASE_NAME,
  serializeNativeProject,
} from "@open-3d/projects";
import { AI_PROVIDER_SETTINGS_STORAGE_KEY, loadAIProviderSettings, saveAIProviderSettings } from "@open-3d/ai/settings";
import { workspacePreferencesStorageKey } from "../src/workspace-preferences";
import { MODELING_COMMANDS, MODELING_QUERIES } from "@open-3d/model-core";
import type { LocalProjectStore, LocalProjectStorageErrorCode } from "@open-3d/projects";
import { createProcessor, emptyDocument } from "../src/workspace/modeling";
import { initializeWorkspacePreferences } from "../src/workspace-preferences";
import { WorkspaceApp } from "../src/app";
import { LocalProjectsDialog } from "../src/workspace/local-projects-dialog";
import { ThreeViewport } from "@open-3d/viewport-three";
import { initializeI18n } from "../src/i18n";
import { useWorkspaceUiStore } from "../src/workspace-ui-store";

let container: HTMLDivElement;
let root: Root;

vi.mock("../src/workspace/ai-provider-sponsors-data", () => ({
  loadAIProviderSponsors: async () => [],
}));

beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  useWorkspaceUiStore.getState().preferenceController?.unsubscribe();
  await initializeI18n("en");
  localStorage.removeItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  localStorage.removeItem(workspacePreferencesStorageKey);
  useWorkspaceUiStore.setState({
    displayPreferences: { theme: "system", language: "system" },
    resolvedPreferences: { theme: "light", language: "en" },
    preferenceController: null,
  });
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  document.documentElement.lang = "en";
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_PROJECTS_DATABASE_NAME);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("Local project database is still in use.")), {
      once: true,
    });
  });
  useWorkspaceUiStore.getState().setNotice("");
  await page.viewport(1440, 1000);
  container = document.createElement("div");
  container.style.height = "100%";
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<WorkspaceApp />));
  await act(async () => {
    await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
  });
});

async function click(target: ReturnType<typeof page.getByRole>) {
  await act(async () => userEvent.click(target));
  if (document.querySelector(".ai-floating-content > [role=status]")?.checkVisibility()) {
    // Let Suspense commit before entering an act-wrapped interaction with the lazy panel.
    await expect.element(page.getByRole("region", { name: /^(AI conversation|AI 对话)$/ })).toBeInTheDocument();
  }
  if (document.querySelector('[data-testid="ai-floating-dialog"][data-open]')) await settleAIPosition();
}

async function settleAIPosition() {
  await expect
    .poll(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="ai-floating-dialog"]');
      return Boolean(
        dialog?.checkVisibility() && dialog.style.visibility !== "hidden" && !dialog.getAnimations().length,
      );
    })
    .toBe(true);
}

let creationReturnPanel: string | undefined;
async function openAddObjectMenu() {
  creationReturnPanel = document.querySelector<HTMLElement>(".studio")?.dataset.panel;
  const left = document.querySelector(".left-panel");
  if (!left?.checkVisibility()) {
    await click(
      page
        .getByRole("navigation", { name: /^(Workspace panels|工作区面板)$/ })
        .getByRole("button", { name: /^(Objects|物体)$/, exact: true }),
    );
  }
  await click(page.getByRole("button", { name: /^(Add object|添加物体)$/ }));
}

async function addPrimitive(primitive: "box" | "uv-sphere" | "cylinder" = "box") {
  await openAddObjectMenu();
  const names = {
    box: /^(Add Box|添加立方体)$/,
    "uv-sphere": /^(Add Sphere|添加球体)$/,
    cylinder: /^(Add Cylinder|添加圆柱体)$/,
  };
  await click(
    page.getByRole("menu", { name: /^(Add object|添加物体)$/ }).getByRole("menuitem", { name: names[primitive] }),
  );
  if (
    creationReturnPanel &&
    creationReturnPanel !== "scene" &&
    document.querySelector(".panel-navigation")?.checkVisibility()
  ) {
    await click(
      page.getByRole("navigation", { name: /^(Workspace panels|工作区面板)$/ }).getByRole("button", {
        name: creationReturnPanel === "viewport" ? /^(3D viewport|3D 视口)$/ : /^(Properties|属性)$/,
      }),
    );
  }
}

async function openAISettings() {
  if (!document.querySelector('[data-testid="ai-floating-dialog"]')?.checkVisibility()) {
    await click(page.getByRole("button", { name: /^(AI chat|AI 对话)$/ }));
  }
  await click(page.getByRole("button", { name: /^(Open AI provider settings|打开 AI 服务设置)$/ }));
}

function chatToolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${id}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function chatTextResponse(id: string, text: string) {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function failingProjectStore(code: LocalProjectStorageErrorCode): LocalProjectStore {
  const fail = (): never => {
    throw new LocalProjectStorageError(
      code,
      code === "quota" ? "Browser storage is full." : "Browser storage is unavailable.",
    );
  };
  return {
    async list() {
      return [];
    },
    async save() {
      return fail();
    },
    async load() {
      return fail();
    },
    async rename() {
      return fail();
    },
    async duplicate() {
      return fail();
    },
    async remove() {
      return fail();
    },
  };
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test("mounts a usable workspace with a browser-rendered viewport", async () => {
  await expect.element(page.getByRole("heading", { name: "Objects" })).toBeInTheDocument();
  const addObjectButton = page.getByRole("button", { name: "Add object", exact: true });
  await expect.element(addObjectButton).toBeVisible();
  expect(document.querySelector('[data-testid="topbar"] button svg')).not.toBeNull();
  await expect.element(page.getByRole("button", { name: "Add object", exact: true })).toBeEnabled();
  await expect.element(page.getByRole("region", { name: "3D viewport" })).toBeInTheDocument();
  expect(document.querySelector("canvas")).not.toBeNull();
});

test.each(["en", "zh-CN"] as const)(
  "omits workspace mode tabs while retaining view controls in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    expect(document.querySelector(".mode-tabs, .mode-tab")).toBeNull();
    await expect
      .element(page.getByRole("tablist", { name: language === "en" ? "Workspace mode" : "工作区模式" }))
      .not.toBeInTheDocument();
    for (const name of language === "en" ? ["Perspective", "Orthographic"] : ["透视", "正交"]) {
      await expect.element(page.getByRole("button", { name, exact: true })).toBeEnabled();
    }
    await expect
      .element(page.getByRole("button", { name: language === "en" ? "View" : "视图", exact: true }))
      .toBeVisible();
  },
);

function semanticColor(token: string) {
  const probe = document.createElement("span");
  probe.style.backgroundColor = `var(--${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

test.each([
  { theme: "light", language: "en" },
  { theme: "dark", language: "en" },
  { theme: "light", language: "zh-CN" },
  { theme: "dark", language: "zh-CN" },
] as const)(
  "keeps an empty canvas unobstructed without a status row in $theme/$language",
  async ({ theme, language }) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    const viewport = page.getByTestId("viewport").element();
    const canvas = viewport.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect([...viewport.children].map((child) => child.className)).toEqual(["viewport-canvas absolute inset-0"]);
    expect(viewport.textContent).toBe("");
    const context = document.querySelector(".context-bar")!;
    expect(document.querySelector(".statusbar")).toBeNull();
    expect(context.nextElementSibling).toBeNull();
    await addPrimitive();
    await click(page.getByRole("button", { name: language === "en" ? "Delete Box" : "删除 立方体", exact: true }));
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    expect(viewport.querySelector("canvas")).toBe(canvas);
    expect(viewport.textContent).toBe("");
    expect(viewport.children).toHaveLength(1);
  },
);

test.each([
  { width: 390, language: "en" },
  { width: 768, language: "en" },
  { width: 999, language: "en" },
  { width: 390, language: "zh-CN" },
  { width: 768, language: "zh-CN" },
  { width: 999, language: "zh-CN" },
] as const)("keeps compact workspace controls aligned at $width in $language", async ({ width, language }) => {
  await page.viewport(width, 844);
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
  const zh = language === "zh-CN";
  for (const selector of [".left-panel", ".right-panel"]) {
    expect(getComputedStyle(document.querySelector(selector)!).padding).toBe("0px");
  }
  expect(document.querySelector(".properties-empty p")).toBeNull();
  await addPrimitive();
  const expectHeight = (selector: string, height = 32) => {
    const elements = [...document.querySelectorAll<HTMLElement>(selector)];
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) expect(element.getBoundingClientRect().height).toBe(height);
  };
  expectHeight('.topbar [data-slot="button"]');
  expectHeight('.panel-navigation [data-slot="button"]');
  expectHeight('.viewport-tools [data-slot="button"]');
  expectHeight(".quick-tool", 24);
  expectHeight(".quick-tools", 28);
  expectHeight(".transform-tools", 28);
  for (const button of document.querySelectorAll(".quick-tool")) {
    expect(getComputedStyle(button).fontSize).toBe("12px");
  }
  expectHeight(".ai-floating-trigger", 44);
  expect(document.querySelector(".viewport-nav")).toBeNull();
  for (const group of [".topbar-actions", ".display-preferences", ".viewport-tools"]) {
    const buttons = [...document.querySelectorAll<HTMLElement>(`${group} [data-slot="button"]`)];
    expect(new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size).toBe(1);
  }
  const nav = page.getByRole("navigation", { name: zh ? "工作区面板" : "Workspace panels" });
  await click(nav.getByRole("button", { name: zh ? "属性" : "Properties", exact: true }));
  expectHeight(".right-panel .section-title");
  expectHeight(".value-field");
  for (const field of document.querySelectorAll(".value-field")) {
    const input = field.querySelector("input")!;
    const rect = input.getBoundingClientRect();
    const outer = field.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(outer.top);
    expect(rect.bottom).toBeLessThanOrEqual(outer.bottom);
  }
  await click(nav.getByRole("button", { name: zh ? "物体" : "Objects", exact: true }));
  expectHeight(".object-row", 36);
  const actions = document.querySelectorAll<HTMLElement>('.object-row > [data-slot="button"]:not(:first-child)');
  expect(actions).toHaveLength(3);
  for (const action of actions) {
    expect(action.getBoundingClientRect().height).toBe(32);
    expect(action.getBoundingClientRect().width).toBe(32);
  }
  await click(page.getByRole("button", { name: zh ? "语言" : "Language", exact: true }));
  await expect
    .poll(() =>
      [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.getBoundingClientRect().height),
    )
    .toEqual([32, 32, 32]);
  await act(async () => userEvent.keyboard("{Escape}"));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
});

test.each([
  { width: 390, language: "en", theme: "light" },
  { width: 768, language: "zh-CN", theme: "dark" },
  { width: 1000, language: "zh-CN", theme: "light" },
  { width: 1440, language: "en", theme: "dark" },
] as const)(
  "keeps the GitHub repository link at the header right at $width in $language/$theme",
  async ({ width, language, theme }) => {
    await page.viewport(width, 900);
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    const link = page.getByRole("link", { name: language === "en" ? "GitHub repository" : "GitHub 仓库", exact: true });
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute("href", "https://github.com/xiaohe0601/open-3d");
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    const rect = link.element().getBoundingClientRect();
    const preferences = document.querySelector(".display-preferences")!.getBoundingClientRect();
    const identity = document.querySelector(".project-identity")!.getBoundingClientRect();
    expect(rect.width).toBe(32);
    expect(rect.height).toBe(32);
    expect(rect.left).toBeGreaterThanOrEqual(preferences.right);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(rect.top).toBe(preferences.top);
    expect(identity.right).toBeLessThanOrEqual(preferences.left);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await act(async () => link.element().focus());
    await expect.element(link).toHaveFocus();
  },
);

test.each([1440, 1120, 1119, 1000, 999, 768, 390])("uses equal panel and tool padding at %ipx", async (width) => {
  await page.viewport(width, 900);
  const expectPadding = (selector: string, value: number) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    expect([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]).toEqual(
      Array(4).fill(`${value}px`),
    );
  };
  expectPadding(".left-panel", width < 1000 ? 0 : width < 1120 ? 6 : 10);
  expectPadding(".right-panel", width < 1000 ? 0 : 12);
  expectPadding(".quick-tools", 2);
  const quick = document.querySelector(".quick-tools")!.getBoundingClientRect();
  const transform = document.querySelector(".transform-tools")!.getBoundingClientRect();
  expect(quick.height).toBe(transform.height);
});

test.each([1440, 768, 390])("fills the studio viewport without root margins or borders at %ipx", async (width) => {
  await page.viewport(width, 900);
  const studio = document.querySelector<HTMLElement>(".studio")!;
  const bounds = studio.getBoundingClientRect();
  expect([bounds.x, bounds.y, bounds.width, bounds.height]).toEqual([0, 0, width, 900]);
  const styles = getComputedStyle(studio);
  expect(styles.margin).toBe("0px");
  expect(styles.borderWidth).toBe("0px");
  expect(document.documentElement.scrollWidth).toBe(width);
});

test("uses Lucide SVGs instead of text glyphs in empty states, disclosures, shortcuts and creation actions", async () => {
  expect(document.querySelector(".properties-empty svg")).not.toBeNull();
  await addPrimitive();
  expect(document.querySelector('kbd[aria-label="Backspace"]')).toBeNull();
  expect(document.querySelectorAll(".section-title svg").length).toBe(1);
  expect(document.querySelector(".studio")!.textContent).not.toMatch(/[⌄⌫◇›▼▲▶◀×→←↑↓✓✕☰⚙]/);
  await openAddObjectMenu();
  expect(document.querySelectorAll(".add-object-menu [role=menuitem] svg")).toHaveLength(3);
  for (const icon of document.querySelectorAll("svg")) expect(icon.textContent).toBe("");
});

test.each(["light", "dark"] as const)("keeps only the animated Transform property group in %s", async (theme) => {
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
  await addPrimitive();
  const trigger = page.getByRole("button", { name: "Toggle Transform section", exact: true });
  const panel = document.getElementById(trigger.element().getAttribute("aria-controls")!)!;
  expect(document.querySelectorAll(".property-section")).toHaveLength(1);
  expect(getComputedStyle(panel).transitionProperty).toBe("height, opacity");
  const name = page.getByRole("textbox", { name: "Object name", exact: true });
  expect(getComputedStyle(name.element()).borderWidth).toBe("1px");
  await click(page.getByRole("button", { name: "Move", exact: true }));
  const position = page.getByRole("spinbutton", { name: "Position X", exact: true });
  await act(async () => userEvent.fill(position, "2.5"));
  await act(async () => userEvent.tab());
  await click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => panel.checkVisibility()).toBe(false);
  await act(async () => {
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
  });
  await expect.poll(() => panel.checkVisibility() && panel.getAnimations().length === 0).toBe(true);
  await expect.element(position).toHaveValue(2.5);
  expect(document.querySelectorAll(".property-section")).toHaveLength(1);
  for (const label of ["Mesh", "Object", "Mesh operations"]) {
    await expect
      .element(page.getByRole("button", { name: `Toggle ${label} section`, exact: true }))
      .not.toBeInTheDocument();
  }
});

test("disables property transitions with reduced motion and supports rapid toggling", async () => {
  await addPrimitive();
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    const trigger = page.getByRole("button", { name: "Toggle Transform section", exact: true });
    const panel = document.getElementById(trigger.element().getAttribute("aria-controls")!)!;
    expect(getComputedStyle(panel).transitionProperty).toBe("none");
    await click(trigger);
    await expect.poll(() => panel.checkVisibility()).toBe(false);
    await act(async () => {
      const button = trigger.element() as HTMLButtonElement;
      button.click();
    });
    await expect.poll(() => panel.checkVisibility()).toBe(true);
    await act(async () => userEvent.keyboard("{Enter}{Enter}"));
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel.getAnimations()).toHaveLength(0);
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test.each(["en", "zh-CN"] as const)(
  "aligns views with repeatable shortcuts and releases them after orbiting in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    const zh = language === "zh-CN";
    const align = vi.spyOn(ThreeViewport.prototype, "alignView");
    const setView = vi.spyOn(ThreeViewport.prototype, "setView");
    const trigger = page.getByRole("button", { name: zh ? "视图" : "View", exact: true });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("menuitem")).not.toBeInTheDocument();
    const chooseView = async (label: string) => {
      await click(trigger);
      const item = page
        .getByRole("menu", { name: zh ? "视图" : "View", exact: true })
        .getByRole("menuitem", { name: label, exact: true });
      await expect.element(item).toBeVisible();
      expect(item.element().hasAttribute("aria-checked")).toBe(false);
      await click(item);
      expect(align.mock.calls.at(-1)?.[0]).toBe(
        (
          {
            前视图: "front",
            后视图: "back",
            左视图: "left",
            右视图: "right",
            顶视图: "top",
            底视图: "bottom",
          } as Record<string, string>
        )[label] ?? label.split(" ")[0].toLowerCase(),
      );
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    };
    for (const label of zh
      ? ["前视图", "后视图", "左视图", "右视图", "顶视图", "底视图"]
      : ["Front view", "Back view", "Left view", "Right view", "Top view", "Bottom view"]) {
      await chooseView(label);
    }
    await chooseView(zh ? "前视图" : "Front view");
    await chooseView(zh ? "前视图" : "Front view");
    expect(align.mock.calls.filter(([view]) => view === "front")).toHaveLength(3);
    await act(async () => {
      trigger.element().focus();
      await userEvent.keyboard("{ArrowDown}");
    });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await act(async () => userEvent.keyboard("{End}{Enter}"));
    expect(align.mock.calls.at(-1)?.[0]).toBe("bottom");
    await act(async () => userEvent.keyboard("{ArrowDown}{Escape}"));
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => document.activeElement === trigger.element()).toBe(true);
    const canvas = document.querySelector("canvas")!;
    const bounds = canvas.getBoundingClientRect();
    const session = cdp();
    const { result } = await session.send("Runtime.evaluate", {
      expression:
        'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
      returnByValue: true,
    });
    const offset = JSON.parse(result.value as string) as { x: number; y: number };
    const point = { x: bounds.x + bounds.width / 2 + offset.x, y: bounds.y + bounds.height / 2 + offset.y };
    await act(async () => {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "middle",
        clickCount: 1,
      });
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x + 50,
        y: point.y + 20,
        buttons: 4,
      });
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x + 50,
        y: point.y + 20,
        button: "middle",
        clickCount: 1,
      });
    });
    await expect.poll(() => setView.mock.calls.at(-1)?.[0]).toBe("user");
    await chooseView(zh ? "前视图" : "Front view");
    expect(align.mock.calls.at(-1)?.[0]).toBe("front");
    await expect.element(page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true })).toBeDisabled();
  },
);

test.each([
  { theme: "light", language: "en" },
  { theme: "dark", language: "zh-CN" },
] as const)(
  "dims nested AI provider settings with the shared scrim in $theme/$language",
  async ({ theme, language }) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    const zh = language === "zh-CN";
    const backdrop = () =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-backdrop"]')].filter((element) =>
        element.checkVisibility(),
      );
    const expected = semanticColor("scrim");
    await openAISettings();
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI provider settings", exact: true });
    await expect.element(dialog).toBeVisible();
    expect(backdrop()).toHaveLength(1);
    expect(getComputedStyle(backdrop()[0]!).backgroundColor).toBe(expected);
    expect(Number(getComputedStyle(backdrop()[0]!).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(page.getByTestId("ai-floating-dialog").element()).zIndex),
    );
    const noticeToggle = dialog.getByRole("button", {
      name: zh ? "本地配置与请求隐私" : "Local settings and request privacy",
      exact: true,
    });
    await expect.element(noticeToggle).toHaveAttribute("aria-expanded", "false");
    const notice = document.getElementById("ai-credential-notice")!;
    expect(notice.checkVisibility()).toBe(false);
    await click(noticeToggle);
    await expect.poll(() => notice.checkVisibility()).toBe(true);
    expect(notice.textContent).toBe(
      zh
        ? "Open 3D 不会上传任何服务配置信息，所有配置均保存在浏览器本地，请确认当前环境安全后再输入相关信息。AI 请求将由浏览器直接发送至服务提供商，不经过 Open 3D 服务器中转。"
        : "Open 3D does not upload any service configuration information. All settings are stored locally in your browser. Please ensure your current environment is secure before entering any information. AI requests are sent directly from your browser to the service provider, without passing through Open 3D servers.",
    );
    const form = dialog.element().querySelector("form")!;
    expect(form.contains(notice)).toBe(false);
    expect(notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect.poll(() => notice.getBoundingClientRect().bottom <= form.getBoundingClientRect().top).toBe(true);
    const key = dialog.getByLabelText(zh ? "API 密钥" : "API key", { exact: false });
    await expect.element(key).toHaveAttribute("aria-describedby", "ai-credential-summary ai-credential-notice");
    await page.viewport(390, 600);
    expect(dialog.element().getBoundingClientRect().height).toBeLessThanOrEqual(568);
    await click(dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    await expect.element(dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true })).toBeVisible();
    await click(
      dialog.getByRole("button", { name: zh ? "关闭 AI 服务设置" : "Close AI provider settings", exact: true }),
    );
    await expect.poll(() => backdrop().length).toBe(0);
    await expect
      .element(page.getByRole("region", { name: zh ? "AI 对话" : "AI conversation", exact: true }))
      .toBeVisible();
  },
);

test.each([1440, 768, 390])("opens a vertical view menu only on click at %ipx", async (width) => {
  await page.viewport(width, 844);
  const trigger = page.getByRole("button", { name: "View", exact: true });
  expect(trigger.element().querySelector(".lucide-panels-top-left")).not.toBeNull();
  await act(async () => userEvent.hover(trigger));
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await click(trigger);
  const menu = page.getByRole("menu", { name: "View", exact: true });
  await expect.element(menu).toBeVisible();
  await expect.poll(() => menu.element().getAnimations({ subtree: true }).length).toBe(0);
  const rect = menu.element().getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(width);
  expect(rect.top).toBeGreaterThanOrEqual(trigger.element().getBoundingClientRect().bottom);
  expect(rect.bottom).toBeLessThanOrEqual(844);
  const items = [...menu.element().querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items).toHaveLength(6);
  items.forEach((item, index) => {
    expect(item.querySelector("svg")).not.toBeNull();
    expect(menu.element().getBoundingClientRect().width).toBeLessThan(140);
    if (index) {
      expect(item.getBoundingClientRect().top).toBeGreaterThanOrEqual(items[index - 1].getBoundingClientRect().bottom);
      expect(item.getBoundingClientRect().left).toBe(items[0].getBoundingClientRect().left);
    }
  });
  await act(async () => userEvent.hover(page.getByRole("button", { name: "Perspective", exact: true })));
  await expect.element(menu).toBeVisible();
  await click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await click(trigger);
  await click(page.getByRole("button", { name: "Perspective", exact: true }));
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await click(trigger);
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.element(trigger).toHaveFocus();
});

test.each(["light", "dark"] as const)(
  "leaves room for project search and AI composer focus rings in %s",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    await page.viewport(390, 844);
    const expectRingUnclipped = (input: Element) => {
      const rect = input.getBoundingClientRect();
      expect(input.matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(input).boxShadow).not.toBe("none");
      for (let ancestor = input.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          expect(rect.left - 3).toBeGreaterThanOrEqual(bounds.left - 0.5);
          expect(rect.right + 3).toBeLessThanOrEqual(bounds.right + 0.5);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          expect(rect.top - 3).toBeGreaterThanOrEqual(bounds.top - 0.5);
          expect(rect.bottom + 3).toBeLessThanOrEqual(bounds.bottom + 0.5);
        }
      }
    };
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    const search = page.getByRole("textbox", { name: "Search projects", exact: true });
    await act(async () => {
      search.element().focus();
      await userEvent.keyboard("{ArrowRight}");
    });
    expectRingUnclipped(search.element());
    await act(async () => userEvent.keyboard("{Escape}"));
    await click(page.getByRole("button", { name: "AI chat", exact: true }));
    const prompt = page.getByRole("textbox", { name: "Message", exact: true });
    await act(async () => {
      prompt.element().focus();
      await userEvent.keyboard("{ArrowRight}");
    });
    expectRingUnclipped(prompt.element());
  },
);

async function expectButtonSurface(target: ReturnType<typeof page.getByRole>, token: string) {
  await expect.poll(() => getComputedStyle(target.element()).backgroundColor).toBe(semanticColor(token));
}

test("switches monochrome chrome and viewport together without replacing the canvas or model", async () => {
  await addPrimitive();
  const canvas = document.querySelector("canvas");
  const appearance = vi.spyOn(ThreeViewport.prototype, "setAppearance");
  const move = page.getByRole("button", { name: "Move", exact: true });
  await click(move);
  for (const theme of ["dark", "light"] as const) {
    await click(page.getByRole("button", { name: "Theme", exact: true }));
    await click(page.getByRole("menuitemradio", { name: theme === "dark" ? "Dark" : "Light", exact: true }));
    expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark");
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(`--${name}`).trim();
    expect(appearance).toHaveBeenLastCalledWith({
      background: token("viewport"),
      grid: token("border"),
      gridMajor: token("input"),
      edge: token("muted"),
    });
    await expectButtonSurface(move, "primary");
    await expect.poll(() => getComputedStyle(move.element()).color).toBe(semanticColor("primary-foreground"));
    await act(async () => userEvent.hover(move));
    await expectButtonSurface(move, "primary");
    expect(document.querySelector("canvas")).toBe(canvas);
    await expect.element(page.getByRole("textbox", { name: "Object name", exact: true })).toHaveValue("Box");
    await expect.element(page.getByRole("spinbutton", { name: "Position X", exact: true })).toHaveValue(0);
  }
});

test.each(["light", "dark"] as const)(
  "keeps toolbar toggle feedback stable through hover, click, keyboard and disabled states in %s",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    const perspective = page.getByRole("button", { name: "Perspective", exact: true });
    const orthographic = page.getByRole("button", { name: "Orthographic", exact: true });
    await expect.element(perspective).toHaveAttribute("aria-pressed", "true");
    await act(async () => userEvent.hover(perspective));
    await expectButtonSurface(perspective, "selection");
    await act(async () => userEvent.hover(orthographic));
    await expectButtonSurface(orthographic, "soft");
    await click(orthographic);
    await expect.element(orthographic).toHaveAttribute("aria-pressed", "true");
    await expect.element(perspective).toHaveAttribute("aria-pressed", "false");
    await expectButtonSurface(orthographic, "selection");
    await act(async () => userEvent.unhover(orthographic));
    await expectButtonSurface(orthographic, "selection");
    await act(async () => {
      perspective.element().focus();
      await userEvent.keyboard("{Enter}");
    });
    await expect.element(perspective).toHaveAttribute("aria-pressed", "true");
    expect(perspective.element().matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(perspective.element()).boxShadow).not.toBe("none");
    expect(getComputedStyle(perspective.element()).transform).toBe("none");
    const vertex = page.getByRole("button", { name: "Vertex", exact: true });
    await expect.element(vertex).toBeDisabled();
    await act(async () => {
      const disabled = vertex.element() as HTMLButtonElement;
      disabled.click();
    });
    await expect
      .element(page.getByRole("button", { name: "Object", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await addPrimitive();
    for (const name of ["Vertex", "Edge", "Face", "Object"]) {
      const button = page.getByRole("button", { name, exact: true });
      await click(button);
      await expectButtonSurface(button, "primary");
      await expect.poll(() => getComputedStyle(button.element()).color).toBe(semanticColor("primary-foreground"));
      expect(document.querySelectorAll('.quick-tools [aria-pressed="true"]')).toHaveLength(1);
      await act(async () => userEvent.unhover(button));
      await expectButtonSurface(button, "primary");
    }
    for (const name of ["Move", "Rotate", "Scale"]) {
      const button = page.getByRole("button", { name, exact: true });
      await act(async () => userEvent.hover(button));
      await expectButtonSurface(button, "selection");
      await click(button);
      await expectButtonSurface(button, "primary");
      await expect.poll(() => getComputedStyle(button.element()).color).toBe(semanticColor("primary-foreground"));
      await act(async () => userEvent.unhover(button));
      await expectButtonSurface(button, "primary");
      expect(document.querySelectorAll('.transform-tools [aria-pressed="true"]')).toHaveLength(1);
      expect(document.querySelector(".axis-constraints")).toBeNull();
      await click(button);
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      await expectButtonSurface(button, "selection");
    }
    const before = perspective.element().getBoundingClientRect().toJSON();
    await act(async () => userEvent.hover(perspective));
    expect(perspective.element().getBoundingClientRect().toJSON()).toEqual(before);
  },
);

test.each(["light", "dark"] as const)(
  "uses neutral feedback for object actions, menus and outlined controls in %s",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    await addPrimitive();
    const hide = page.getByRole("button", { name: "Hide Box", exact: true });
    await act(async () => userEvent.hover(hide));
    await expectButtonSurface(hide, "soft");
    const hitbox = hide.element().getBoundingClientRect();
    expect(hitbox.width).toBeGreaterThanOrEqual(hitbox.height - 1);
    await click(hide);
    await click(page.getByRole("button", { name: "Show Box", exact: true }));
    for (const target of [
      page.getByRole("button", { name: "Duplicate Box", exact: true }),
      page.getByRole("button", { name: "Save", exact: true }),
      page.getByRole("button", { name: "Open projects", exact: true }),
    ]) {
      await act(async () => userEvent.hover(target));
      await expectButtonSurface(target, "soft");
      expect(getComputedStyle(target.element()).color).not.toBe(semanticColor("primary-foreground"));
    }
    const remove = page.getByRole("button", { name: "Delete Box", exact: true });
    await act(async () => userEvent.hover(remove));
    await expectButtonSurface(remove, "negative-soft");
  },
);

test.each(["light", "dark"] as const)(
  "preserves selected panel feedback while hovering narrow-screen navigation in %s",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    await page.viewport(390, 844);
    const nav = page.getByRole("navigation", { name: "Workspace panels" });
    for (const name of ["Objects", "Properties", "3D viewport"]) {
      const button = nav.getByRole("button", { name, exact: true });
      await click(button);
      await expectButtonSurface(button, "selection");
      expect(document.querySelectorAll('.panel-navigation [aria-pressed="true"]')).toHaveLength(1);
      const bounds = button.element().getBoundingClientRect();
      expect(bounds.height).toBe(32);
      await act(async () => userEvent.unhover(button));
      await expectButtonSurface(button, "selection");
    }
  },
);

test.each([390, 768])("keeps narrow-screen tools reachable below the default AI launcher at %ipx", async (width) => {
  await page.viewport(width, 844);
  await addPrimitive();
  const launcher = page.getByRole("button", { name: "AI chat", exact: true });
  const launcherBounds = launcher.element().getBoundingClientRect();
  for (const name of ["Object", "Vertex", "Edge", "Face", "Move", "Rotate", "Scale"]) {
    const button = page.getByRole("button", { name, exact: true });
    const element = button.element();
    const bounds = element.getBoundingClientRect();
    expect(bounds.bottom <= launcherBounds.top || bounds.top >= launcherBounds.bottom).toBe(true);
    expect(element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))).toBe(
      true,
    );
    await click(button);
    await expect.element(button).toHaveAttribute("aria-pressed", "true");
  }
});

test.each(["light", "dark"] as const)(
  "keeps native pointer-down feedback stationary and consistent in %s",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    const session = cdp();
    const { result } = await session.send("Runtime.evaluate", {
      expression:
        'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
      returnByValue: true,
    });
    const offset = JSON.parse(result.value as string) as { x: number; y: number };
    for (const [name, surface] of [
      ["Perspective", "selection"],
      ["Orthographic", "selection"],
    ]) {
      const button = page.getByRole("button", { name, exact: true });
      const before = button.element().getBoundingClientRect().toJSON();
      const point = { x: before.x + before.width / 2 + offset.x, y: before.y + before.height / 2 + offset.y };
      await act(async () => {
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          clickCount: 1,
        });
      });
      try {
        expect(button.element().matches(":active")).toBe(true);
        await expectButtonSurface(button, surface);
        expect(button.element().getBoundingClientRect().toJSON()).toEqual(before);
        expect(getComputedStyle(button.element()).transform).toBe("none");
      } finally {
        await act(async () =>
          session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }),
        );
      }
    }
    const add = page.getByRole("button", { name: "Add object", exact: true });
    const bounds = add.element().getBoundingClientRect().toJSON();
    await click(add);
    await expect.element(page.getByRole("menu", { name: "Add object", exact: true })).toBeVisible();
    expect(add.element().getBoundingClientRect().toJSON()).toEqual(bounds);
    await expectButtonSurface(add, "soft");
    await act(async () => userEvent.keyboard("{Escape}"));
  },
);

test("applies saved display preferences synchronously before React mounts", () => {
  const bootstrapElement = document.createElement("html");
  const preferences = { version: 1, preferences: { theme: "dark", language: "zh-CN" } };
  const result = initializeWorkspacePreferences(
    bootstrapElement,
    {
      getItem: () => JSON.stringify(preferences),
      setItem: () => {},
    },
    null,
  );

  expect(result.resolved).toEqual({ theme: "dark", language: "zh-CN" });
  expect(bootstrapElement.dataset.theme).toBe("dark");
  expect(bootstrapElement.classList.contains("dark")).toBe(true);
  expect(bootstrapElement.style.colorScheme).toBe("dark");
  expect(bootstrapElement.lang).toBe("zh-CN");
});

test.each(["en", "zh-CN"] as const)(
  "switches topbar preferences with radio menus and keyboard in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "system", language }));
    const zh = language === "zh-CN";
    const canvas = document.querySelector("canvas");
    const theme = page.getByRole("button", { name: zh ? "主题" : "Theme", exact: true });
    const languageButton = page.getByRole("button", { name: zh ? "语言" : "Language", exact: true });
    await expect
      .element(page.getByRole("button", { name: zh ? "工作区设置" : "Workspace settings", exact: true }))
      .not.toBeInTheDocument();
    const importButton = page.getByRole("button", {
      name: zh ? "导入项目 / GLB / glTF" : "Import project / GLB / glTF",
      exact: true,
    });
    const exportButton = page.getByRole("button", { name: zh ? "导出" : "Export", exact: true });
    expect(importButton.element().querySelector("svg")?.classList.contains("lucide-download")).toBe(true);
    expect(exportButton.element().querySelector("svg")?.classList.contains("lucide-upload")).toBe(true);
    await expect.element(theme).toHaveAttribute("aria-haspopup", "menu");
    await expect.element(languageButton).toHaveAttribute("aria-haspopup", "menu");
    await click(theme);
    await expect
      .element(page.getByRole("menuitemradio", { name: zh ? "跟随系统" : "Follow system", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.element(theme).toHaveFocus();
    for (const [preference, label] of [
      ["dark", zh ? "深色" : "Dark"],
      ["light", zh ? "浅色" : "Light"],
      ["system", zh ? "跟随系统" : "Follow system"],
    ] as const) {
      await click(theme);
      await click(page.getByRole("menuitemradio", { name: label, exact: true }));
      await expect
        .element(page.getByRole("menu", { name: zh ? "主题" : "Theme", exact: true }))
        .not.toBeInTheDocument();
      expect(useWorkspaceUiStore.getState().displayPreferences.theme).toBe(preference);
      if (preference !== "system") expect(document.documentElement.dataset.theme).toBe(preference);
      expect(theme.element().getAttribute("title")).toBe(`${zh ? "主题" : "Theme"}: ${label}`);
      await click(theme);
      await expect
        .element(page.getByRole("menuitemradio", { name: label, exact: true }))
        .toHaveAttribute("aria-checked", "true");
      await act(async () => userEvent.keyboard("{Escape}"));
    }
    await click(languageButton);
    await expect.element(page.getByRole("menuitemradio", { name: "English", exact: true })).toBeVisible();
    await expect.element(page.getByRole("menuitemradio", { name: "简体中文", exact: true })).toBeVisible();
    for (const label of ["English", "简体中文"]) {
      expect(page.getByRole("menuitemradio", { name: label, exact: true }).element().textContent).toBe(label);
    }
    expect(
      page
        .getByRole("menuitemradio", { name: zh ? "跟随系统" : "Follow system", exact: true })
        .element()
        .querySelector(":scope > svg"),
    ).toBeNull();
    await expect
      .element(page.getByRole("menuitemradio", { name: zh ? "简体中文" : "English", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await click(page.getByRole("menuitemradio", { name: zh ? "跟随系统" : "Follow system", exact: true }));
    expect(useWorkspaceUiStore.getState().displayPreferences.language).toBe("system");
    expect(document.querySelector("canvas")).toBe(canvas);
  },
);

test.each([1440, 768, 390])(
  "frames the canvas with four borders, rounded corners and bottom breathing room at %s",
  async (width) => {
    await page.viewport(width, 900);
    await addPrimitive();
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      expect(style(".center-stage")[`border${side}Width`]).toBe("1px");
    }
    for (const corner of ["TopLeft", "TopRight", "BottomLeft", "BottomRight"] as const) {
      expect(parseFloat(style(".center-stage")[`border${corner}Radius`])).toBeGreaterThan(0);
    }
    const bounds = document.querySelector(".center-stage")!.getBoundingClientRect();
    expect(innerHeight - bounds.bottom).toBe(12);
    if (width < 1000) expect(bounds.left).toBe(8);
    expect(style(".center-stage").borderTopRightRadius).toBe(style(".center-stage").borderTopLeftRadius);
    expect(style(".panel-navigation").borderBottomWidth).toBe("0px");
    expect(style(".transform-tools").borderLeftWidth).toBe("0px");
    expect(style(".context-bar").borderTopWidth).toBe("1px");
    const sections = document.querySelectorAll<HTMLElement>(".right-panel .property-section");
    expect(sections.length).toBeGreaterThan(0);
    expect(getComputedStyle(sections[sections.length - 1]!).borderBottomWidth).toBe("0px");
  },
);

test("persists display preferences separately from saved and exported projects", async () => {
  await click(page.getByRole("button", { name: "Theme", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Dark", exact: true }));
  await click(page.getByRole("button", { name: "Language", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "English", exact: true }));

  const savedPreferences = localStorage.getItem(workspacePreferencesStorageKey);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(document.documentElement.lang).toBe("en");
  expect(JSON.parse(savedPreferences!)).toEqual({
    version: 1,
    preferences: { theme: "dark", language: "en" },
  });

  let exportedBlob: Blob | undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
    exportedBlob = object as Blob;
    return "blob:workspace-preferences-isolation";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
  expect(document.querySelector(".context-copy")!.textContent).not.toContain("saved");
  await expect.element(page.getByRole("status")).toHaveTextContent("");
  await click(page.getByRole("button", { name: "Export", exact: true }));
  await click(page.getByRole("menuitem", { name: "open3d", exact: true }));

  expect(localStorage.getItem(workspacePreferencesStorageKey)).toBe(savedPreferences);
  expect(exportedBlob).toBeInstanceOf(Blob);
  const exportedDocument = await exportedBlob!.text();
  expect(exportedDocument).not.toContain("workspace-preferences");
  expect(exportedDocument).not.toContain("themePreference");
  expect(exportedDocument).not.toContain("languagePreference");
});

test("omits corner guidance and the deferred statusbar", async () => {
  expect(document.querySelector(".viewport-coordinates, .viewport-nav, .statusbar")).toBeNull();
  await expect.element(page.getByRole("button", { name: "Viewport navigation help" })).not.toBeInTheDocument();
});

test("keeps transient notices from blocking workspace controls", async () => {
  await addPrimitive();
  const toast = page.getByRole("status").last();
  await expect.element(toast).toHaveTextContent("Object added to the scene");
  expect(getComputedStyle(toast.element()).pointerEvents).toBe("none");
  await new Promise((resolve) => window.setTimeout(resolve, 3100));
  await expect.element(toast).toHaveTextContent("");
  await click(page.getByRole("button", { name: "Move", exact: true }));
});

test.each(["light", "dark"] as const)("adds objects from a non-modal menu without presets in %s", async (theme) => {
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
  const trigger = page.getByTestId("left-panel").getByRole("button", { name: "Add object", exact: true });
  expect(page.getByRole("button", { name: "Add object", exact: true }).elements()).toHaveLength(1);
  expect(document.querySelector('.topbar button[aria-label="Add object"]')).toBeNull();
  expect(document.querySelector(".viewport-empty button")).toBeNull();
  expect(getComputedStyle(document.querySelector(".left-panel .panel-heading")!).paddingRight).toBe("0px");
  await click(trigger);
  await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu", { name: "Add object", exact: true });
  await expect.element(menu).toBeVisible();
  await expect.poll(() => menu.element().getAnimations().length).toBe(0);
  expect(menu.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    trigger.element().getBoundingClientRect().bottom,
  );
  expect(menu.getByRole("menuitem").elements()).toHaveLength(3);
  expect(document.querySelector('[role="dialog"], [data-slot="dialog-backdrop"], .template-options')).toBeNull();
  for (const name of ["Add Box", "Add Sphere", "Add Cylinder"]) {
    await expect.element(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  expect(menu.element().textContent).not.toMatch(/Starter|Room blockout|Empty scene|Product study|Mesh study/);
  await click(menu.getByRole("menuitem", { name: "Add Box", exact: true }));
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  await addPrimitive("uv-sphere");
  await addPrimitive("cylinder");
  for (const name of ["Box", "Sphere", "Cylinder"]) {
    await expect.element(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await click(page.getByRole("button", { name: "Undo", exact: true }));
  await expect.element(page.getByRole("button", { name: "Cylinder", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Redo", exact: true }));
  await expect.element(page.getByRole("button", { name: "Cylinder", exact: true })).toBeVisible();
  await openAddObjectMenu();
  await click(page.getByRole("button", { name: "Perspective", exact: true }));
  await expect.element(menu).not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-testid="object-row"]')).toHaveLength(3);
});

test.each(["en", "zh-CN"] as const)(
  "keeps the object menu reachable in a short mobile viewport in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "dark", language }));
    await page.viewport(390, 600);
    const zh = language === "zh-CN";
    await openAddObjectMenu();
    const trigger = page.getByRole("button", { name: zh ? "添加物体" : "Add object", exact: true });
    const menu = page.getByRole("menu", { name: zh ? "添加物体" : "Add object", exact: true });
    await expect.element(menu).toBeVisible();
    await expect.poll(() => menu.element().getAnimations().length).toBe(0);
    const bounds = menu.element().getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(390);
    expect(bounds.top).toBeGreaterThanOrEqual(trigger.element().getBoundingClientRect().bottom);
    expect(bounds.bottom).toBeLessThanOrEqual(600);
    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.element(menu).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await act(async () => userEvent.keyboard("{ArrowDown}"));
    await expect.element(menu.getByRole("menuitem").first()).toHaveFocus();
    await act(async () => userEvent.keyboard("{End}{Enter}"));
    await expect.element(menu).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await expect.element(page.getByRole("button", { name: zh ? "圆柱体" : "Cylinder", exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
);

test.each([
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
])("keeps the workspace panels within the $width x $height desktop layout", async ({ width, height }) => {
  await page.viewport(width, height);

  const leftPanel = document.querySelector('[data-testid="left-panel"]')?.getBoundingClientRect();
  const viewport = document.querySelector('[data-testid="center-stage"]')?.getBoundingClientRect();
  const rightPanel = document.querySelector('[data-testid="right-panel"]')?.getBoundingClientRect();

  expect(leftPanel).toBeDefined();
  expect(viewport).toBeDefined();
  expect(rightPanel).toBeDefined();
  expect(leftPanel!.right).toBeLessThanOrEqual(viewport!.left);
  expect(viewport!.right).toBeLessThanOrEqual(rightPanel!.left);
  expect(rightPanel!.right).toBeLessThanOrEqual(width);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await expect.element(page.getByRole("region", { name: "3D viewport" })).toBeInTheDocument();
});

test("creates, renames, duplicates, and undoes a scene object", async () => {
  const initialCanvas = document.querySelector("canvas");
  await addPrimitive();
  expect(document.querySelector("canvas")).toBe(initialCanvas);
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();

  const nameField = page.getByRole("textbox", { name: "Object name" });
  await act(async () => userEvent.fill(nameField, "Desk block"));
  await act(async () => userEvent.keyboard("{Enter}"));
  await expect.element(page.getByRole("button", { name: "Desk block", exact: true })).toBeInTheDocument();

  await click(page.getByRole("button", { name: "Duplicate Desk block", exact: true }));
  await expect.element(page.getByRole("button", { name: "Desk block copy", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Undo" }));
  expect(document.querySelector("canvas")).toBe(initialCanvas);
  await expect.element(page.getByRole("button", { name: "Desk block copy", exact: true })).not.toBeInTheDocument();
});

test.each(["en", "zh-CN"] as const)("shows a flat object list without a scene root in %s", async (language) => {
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
  const panel = page.getByRole("complementary", { name: language === "en" ? "Objects" : "物体", exact: true });
  await expect.element(panel).toBeVisible();
  expect(panel.element().querySelector(".scene-root, .scene-glyph, .disclosure")).toBeNull();
  await expect.element(panel.getByText(language === "en" ? "Scene" : "场景", { exact: true })).not.toBeInTheDocument();
  await expect.element(panel.getByText(language === "en" ? "0 objects" : "0 个物体", { exact: true })).toBeVisible();
  await addPrimitive();
  await addPrimitive("uv-sphere");
  const rows = panel.getByTestId("object-row").elements();
  expect(rows).toHaveLength(2);
  await expect.element(panel.getByText(language === "en" ? "2 objects" : "2 个物体", { exact: true })).toBeVisible();
  for (const row of rows) {
    expect(row.parentElement).toBe(panel.element().querySelector(".object-list"));
    const button = row.querySelector("button")!;
    expect(button.getBoundingClientRect().left - row.getBoundingClientRect().left).toBeLessThan(16);
  }
  await click(panel.getByRole("button", { name: language === "en" ? "Box" : "立方体", exact: true }));
  await expect
    .element(page.getByRole("textbox", { name: language === "en" ? "Object name" : "物体名称" }))
    .toHaveValue(language === "en" ? "Box" : "立方体");
});

test("manages scene objects from the hierarchy", async () => {
  await addPrimitive();
  await click(page.getByRole("button", { name: "Hide Box" }));
  await expect.element(page.getByRole("button", { name: "Show Box" })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Show Box" }));
  await expect.element(page.getByRole("button", { name: "Hide Box" })).toBeInTheDocument();

  await click(page.getByRole("button", { name: "Duplicate Box" }));
  await expect.element(page.getByRole("button", { name: "Box copy", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Delete Box copy" }));
  await expect.element(page.getByRole("button", { name: "Box copy", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
});

test("completes a first scene-building workflow without AI", async () => {
  expect(document.querySelector(".viewport-empty")).toBeNull();

  await addPrimitive();
  const boxName = page.getByRole("textbox", { name: "Object name" });
  await act(async () => userEvent.fill(boxName, "Table top"));
  await act(async () => userEvent.keyboard("{Enter}"));
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();

  const positionX = page.getByRole("spinbutton", { name: "Position X" }).nth(0);
  await act(async () => userEvent.fill(positionX, "1.25"));
  await act(async () => userEvent.tab());
  await expect.element(page.getByRole("status")).toHaveTextContent("Position updated");
  await expect.element(positionX).toHaveValue(1.25);

  await addPrimitive("uv-sphere");
  await expect.element(page.getByRole("button", { name: "Sphere", exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("2 objects", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("commits a numeric transform as a document edit", async () => {
  await addPrimitive();
  const positionX = page.getByRole("spinbutton", { name: "Position X" }).nth(0);
  await act(async () => userEvent.fill(positionX, "2"));
  await act(async () => userEvent.keyboard("{Tab}"));
  await expect.element(page.getByRole("status")).toHaveTextContent("Position updated");
  await expect.element(positionX).toHaveValue(2);

  await click(page.getByRole("button", { name: "Undo" }));
  await expect.element(positionX).toHaveValue(0);
});

test.each([
  { theme: "light", language: "en" },
  { theme: "dark", language: "en" },
  { theme: "light", language: "zh-CN" },
  { theme: "dark", language: "zh-CN" },
] as const)(
  "keeps the inspector unchanged when selecting transform tools in $theme/$language",
  async ({ theme, language }) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    await addPrimitive();
    const inspector = page.getByTestId("right-panel").element();
    expect(inspector.textContent).not.toContain(language === "zh-CN" ? "网格物体" : "Mesh object");
    expect(inspector.querySelector(".object-summary small")).toBeNull();
    const content = inspector.textContent;
    const fieldNames = () => [...inspector.querySelectorAll("input")].map((input) => input.getAttribute("aria-label"));
    const initialFields = fieldNames();
    expect(inspector.querySelectorAll('input[type="number"]')).toHaveLength(9);
    expect(inspector.querySelector(".field-note")).toBeNull();
    for (const name of language === "en" ? ["Move", "Rotate", "Scale"] : ["移动", "旋转", "缩放"]) {
      const tool = page.getByRole("button", { name, exact: true });
      await click(tool);
      await expect.element(tool).toHaveAttribute("aria-pressed", "true");
      expect(inspector.textContent).toBe(content);
      expect(fieldNames()).toEqual(initialFields);
      expect(
        inspector.querySelector(
          ".transform-preview-options, .transform-preview-actions, .axis-constraints, [role=combobox], [role=checkbox]",
        ),
      ).toBeNull();
      expect(inspector.querySelectorAll('input[type="number"]')).toHaveLength(9);
      expect(document.querySelector(".statusbar")).toBeNull();
      await click(tool);
      await expect.element(tool).toHaveAttribute("aria-pressed", "false");
      expect(inspector.textContent).toBe(content);
    }
  },
);

test.each([
  { tool: "Move", field: "Position X", initial: 0, expected: 0.4 },
  { tool: "Rotate", field: "Rotation X", initial: 0, expected: 0.524 },
  { tool: "Scale", field: "Scale X", initial: 1, expected: 1.4 },
])(
  "retains viewport $tool drag, cancellation and undo without inspector configuration",
  async ({ tool, field, initial, expected }) => {
    await addPrimitive();
    const setDocument = vi.spyOn(ThreeViewport.prototype, "setDocument");
    await click(page.getByRole("button", { name: tool, exact: true }));
    const input = page.getByRole("spinbutton", { name: field, exact: true });
    const canvas = document.querySelector("canvas")!;
    const bounds = canvas.getBoundingClientRect();
    const session = cdp();
    const { result } = await session.send("Runtime.evaluate", {
      expression:
        'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
      returnByValue: true,
    });
    const offset = JSON.parse(result.value as string) as { x: number; y: number };
    const start = { x: bounds.x + bounds.width / 2 + offset.x, y: bounds.y + bounds.height / 2 + offset.y };
    const end = { x: start.x + 40, y: start.y + 20 };
    async function previewDrag() {
      await act(async () => {
        canvas.focus();
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...start,
          button: "left",
          clickCount: 1,
        });
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...end, buttons: 1 });
      });
    }
    async function releaseDrag() {
      await act(async () =>
        session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", clickCount: 1 }),
      );
    }
    await previewDrag();
    await expect.element(input).toHaveValue(initial);
    const preview = setDocument.mock.calls.at(-1)?.[0];
    expect(
      preview?.objects[0]?.transform[tool === "Move" ? "position" : tool === "Rotate" ? "rotation" : "scale"],
    ).not.toEqual(tool === "Scale" ? [1, 1, 1] : tool === "Rotate" ? [0, 0, 0, 1] : [0, 0, 0]);
    await act(async () => userEvent.keyboard("{Escape}"));
    await releaseDrag();
    await expect.element(input).toHaveValue(initial);
    await previewDrag();
    await releaseDrag();
    await expect.element(input).toHaveValue(expected);
    expect(document.querySelectorAll('.right-panel input[type="number"]')).toHaveLength(9);
    await click(page.getByRole("button", { name: "Undo", exact: true }));
    await expect.element(input).toHaveValue(initial);
    await click(page.getByRole("button", { name: "Redo", exact: true }));
    await expect.element(input).toHaveValue(expected);
  },
);

test("retains face selection while mesh operation UI is deferred", async () => {
  await addPrimitive();
  await click(page.getByRole("button", { name: "Face", exact: true }));
  await act(async () => userEvent.click(document.querySelector("canvas")!));
  await expect.element(page.getByRole("status")).toHaveTextContent("Component selection updated");
  await expect.element(page.getByRole("combobox", { name: "Operation", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Apply operation" })).not.toBeInTheDocument();
  expect(document.querySelectorAll(".property-section")).toHaveLength(1);
});

test.each([
  { width: 390, language: "en" },
  { width: 768, language: "en" },
  { width: 390, language: "zh-CN" },
  { width: 768, language: "zh-CN" },
] as const)("keeps project actions on one accessible row at $width in $language", async ({ width, language }) => {
  await page.viewport(width, 900);
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
  const zh = language === "zh-CN";
  await expect
    .element(page.getByRole("group", { name: zh ? "项目与文件" : "Project and files", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("group", { name: zh ? "编辑与创建" : "Edit and create", exact: true }))
    .toBeVisible();
  const preferences = [...document.querySelectorAll<HTMLElement>('.display-preferences [data-slot="button"]')];
  expect(preferences).toHaveLength(2);
  const identity = document.querySelector(".project-name")!.getBoundingClientRect();
  for (const button of preferences) {
    const rect = button.getBoundingClientRect();
    expect(rect.height).toBe(32);
    expect(rect.width).toBe(32);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(Math.abs(rect.top - identity.top)).toBeLessThan(1);
  }
  const actions = [...document.querySelectorAll<HTMLElement>('.topbar-actions [data-slot="button"]')];
  expect(actions).toHaveLength(6);
  const rects = actions.map((action) => action.getBoundingClientRect());
  expect(new Set(rects.map((rect) => Math.round(rect.top))).size).toBe(1);
  for (const [index, rect] of rects.entries()) {
    expect(rect.height).toBe(32);
    if (width === 390) expect(rect.width).toBe(32);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(actions[index]!.getAttribute("aria-label") || actions[index]!.textContent!.trim()).toBeTruthy();
  }
  await expect
    .element(page.getByRole("button", { name: language === "en" ? "Rename project" : "重命名项目", exact: true }))
    .toBeVisible();
});

test.each(["en", "zh-CN"] as const)(
  "renames projects from the header without losing history in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    const zh = language === "zh-CN";
    await addPrimitive();
    const canvas = document.querySelector("canvas");
    await page.viewport(390, 900);
    const trigger = page.getByRole("button", { name: zh ? "重命名项目" : "Rename project", exact: true });
    await expect.element(trigger).toBeVisible();
    const original = trigger.element().querySelector("span")!.textContent;
    await click(trigger);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    const input = page.getByRole("textbox", { name: zh ? "项目名称" : "Project name", exact: true });
    await expect.element(input).toHaveFocus();
    await act(async () => userEvent.fill(input, "   "));
    await act(async () => userEvent.keyboard("{Enter}"));
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await expect.element(page.getByRole("alert")).toHaveTextContent(zh ? "请输入项目名称" : "Enter a project name");
    await act(async () => userEvent.fill(input, "  My 桌子  "));
    await act(async () => userEvent.keyboard("{Enter}"));
    await expect.element(input).not.toBeInTheDocument();
    await expect.poll(() => trigger.element().textContent).toContain("My 桌子");
    expect(document.querySelector("canvas")).toBe(canvas);
    await click(page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true }));
    await expect.poll(() => trigger.element().textContent).toContain(original!);
    expect(document.querySelectorAll(".object-row")).toHaveLength(1);
    await click(page.getByRole("button", { name: zh ? "重做" : "Redo", exact: true }));
    await click(trigger);
    await act(async () => userEvent.fill(input, "Cancelled name"));
    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.poll(() => trigger.element().textContent).toContain("My 桌子");
    await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    const store = createLocalProjectStore();
    try {
      await expect.poll(async () => (await store.list()).map((p) => p.name)).toEqual(["My 桌子"]);
      const [saved] = await store.list();
      expect((await store.load(saved!.id)).objects).toHaveLength(1);
    } finally {
      store.close?.();
    }
  },
);

test.each(["en", "zh-CN"] as const)(
  "commits header edits on blur and preserves composition/cancellation in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "dark", language }));
    const zh = language === "zh-CN";
    const trigger = page.getByRole("button", { name: zh ? "重命名项目" : "Rename project", exact: true });
    const original = trigger.element().textContent;
    await click(trigger);
    const input = page.getByRole("textbox", { name: zh ? "项目名称" : "Project name", exact: true });
    await act(async () => userEvent.fill(input, "    "));
    await click(page.getByRole("button", { name: zh ? "视图" : "View", exact: true }));
    await expect.poll(() => trigger.element().textContent).toBe(original);
    await act(async () => userEvent.keyboard("{Escape}"));
    await click(trigger);
    await act(async () => userEvent.fill(input, "A long project name with 中文 and spaces"));
    await act(async () =>
      input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })),
    );
    await expect.element(input).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true })).toBeDisabled();
    await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    await expect.poll(() => trigger.element().textContent).toContain("A long project name with 中文 and spaces");
    await expect.element(page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true })).toBeEnabled();
    await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe(zh ? "已保存" : "Saved");
    await click(trigger);
    await act(async () => userEvent.fill(input, "Discard this draft"));
    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.element(trigger).toHaveFocus();
    await expect.poll(() => trigger.element().textContent).toContain("A long project name with 中文 and spaces");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  },
);

test.each(["en", "zh-CN"] as const)(
  "manages saved projects with search, rename, copy and safe deletion in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "dark", language }));
    const zh = language === "zh-CN";
    await addPrimitive();
    await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    await addPrimitive("cylinder");
    await click(page.getByRole("button", { name: zh ? "打开项目" : "Open projects", exact: true }));
    const dialog = page.getByRole("dialog", { name: zh ? "项目" : "Projects", exact: true });
    const current = dialog.element().querySelector<HTMLElement>('[data-project-id][aria-current="true"]')!;
    expect(current).not.toBeNull();
    expect(getComputedStyle(current).backgroundColor).toBe(semanticColor("selection"));
    expect(getComputedStyle(current).borderWidth).toBe("0px");
    expect(current.querySelector(".lucide-check")).toBeNull();
    await expect
      .element(dialog.getByText(zh ? "当前项目" : "Current project", { exact: true }))
      .not.toBeInTheDocument();
    expect(dialog.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(360);
    const store = createLocalProjectStore();
    try {
      const [original] = await store.list();
      const before = await store.load(original!.id);
      const manage = (name: string) =>
        dialog.getByRole("button", { name: zh ? `管理 ${name}` : `Manage ${name}`, exact: true });
      await click(manage(original!.name));
      await click(page.getByRole("menuitem", { name: zh ? "重命名" : "Rename", exact: true }));
      const renameDialog = page.getByRole("dialog", { name: zh ? "重命名项目" : "Rename project", exact: true });
      const nameInput = renameDialog.getByRole("textbox", { name: zh ? "项目名称" : "Project name", exact: true });
      expect(renameDialog.element().querySelector('[data-slot="dialog-title"]')?.classList.contains("sr-only")).toBe(
        true,
      );
      expect(renameDialog.element().getAttribute("aria-describedby")).toBeNull();
      await act(async () => userEvent.fill(nameInput, "   "));
      await click(
        page
          .getByRole("dialog", { name: zh ? "重命名项目" : "Rename project", exact: true })
          .getByRole("button", { name: zh ? "保存" : "Save", exact: true }),
      );
      await expect.element(nameInput).toHaveAttribute("aria-invalid", "true");
      await act(async () => userEvent.fill(nameInput, "  Desk project  "));
      await click(
        page
          .getByRole("dialog", { name: zh ? "重命名项目" : "Rename project", exact: true })
          .getByRole("button", { name: zh ? "保存" : "Save", exact: true }),
      );
      await expect.element(manage("Desk project")).toBeVisible();
      expect(await store.load(original!.id)).toEqual({ ...before, name: "Desk project" });
      await click(manage("Desk project"));
      await click(page.getByRole("menuitem", { name: zh ? "复制" : "Duplicate", exact: true }));
      const copyName = zh ? "Desk project 副本" : "Desk project copy";
      await expect.element(manage(copyName)).toBeVisible();
      const saved = await store.list();
      expect(saved).toHaveLength(2);
      const copy = saved.find((p) => p.id !== original!.id)!;
      expect(await store.load(copy.id)).toEqual({ ...before, name: copyName });
      const search = dialog.getByRole("textbox", { name: zh ? "搜索项目" : "Search projects", exact: true });
      await act(async () => userEvent.fill(search, zh ? "副本" : "COPY"));
      await expect.element(manage(copyName)).toBeVisible();
      await expect.element(manage("Desk project")).not.toBeInTheDocument();
      await act(async () => userEvent.fill(search, "unmatched"));
      await expect.element(dialog.getByText(zh ? "没有匹配的项目" : "No projects match your search")).toBeVisible();
      await act(async () => userEvent.clear(search));
      await click(manage(copyName));
      await click(page.getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true }));
      await click(
        page
          .getByRole("dialog", { name: zh ? "删除项目？" : "Delete project?", exact: true })
          .getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }),
      );
      expect(await store.list()).toHaveLength(2);
      await click(manage(copyName));
      await click(page.getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true }));
      await click(
        page
          .getByRole("dialog", { name: zh ? "删除项目？" : "Delete project?", exact: true })
          .getByRole("button", { name: zh ? "删除" : "Delete", exact: true }),
      );
      await expect.element(manage(copyName)).not.toBeInTheDocument();
      expect((await store.list()).map((p) => p.id)).toEqual([original!.id]);
      await click(manage("Desk project"));
      await click(page.getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true }));
      await click(
        page
          .getByRole("dialog", { name: zh ? "删除项目？" : "Delete project?", exact: true })
          .getByRole("button", { name: zh ? "删除" : "Delete", exact: true }),
      );
      await expect
        .element(dialog.getByText(zh ? "此浏览器中尚无已保存的项目" : "No saved projects in this browser yet"))
        .toBeVisible();
      expect(await store.list()).toHaveLength(0);
      await click(dialog.getByRole("button", { name: zh ? "关闭项目" : "Close projects", exact: true }));
      await expect.element(page.getByRole("button", { name: zh ? "立方体" : "Box", exact: true })).toBeVisible();
      await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
      await expect.poll(async () => (await store.list()).length).toBe(1);
      const [resaved] = await store.list();
      expect(resaved!.id).not.toBe(original!.id);
      expect(resaved!.name).toBe("Desk project");
      const resavedDocument = await store.load(resaved!.id);
      expect(resavedDocument.objects).toHaveLength(2);
      expect(resavedDocument.objects[0]).toEqual(before.objects[0]);
    } finally {
      store.close?.();
    }
  },
);

test.each([
  { width: 1440, height: 900, language: "en", theme: "light" },
  { width: 390, height: 700, language: "zh-CN", theme: "dark" },
  { width: 390, height: 400, language: "en", theme: "dark" },
] as const)(
  "keeps project dialog height stable across content states at $width x $height in $language",
  async ({ width, height, language, theme }) => {
    await page.viewport(width, height);
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    const projects = Array.from({ length: 20 }, (_, index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
      updatedAt: "2026-10-22T00:00:00Z",
    }));
    const callbacks = {
      onOpenChange: vi.fn(),
      onOpenProject: vi.fn(),
      onDuplicateProject: vi.fn(),
      onRenameProject: vi.fn(async () => true),
      onDeleteProject: vi.fn(async () => true),
    };
    const zh = language === "zh-CN";
    const dialog = page.getByRole("dialog", { name: zh ? "项目" : "Projects", exact: true });
    const expected = Math.min(520, height - 32);
    let searchTop: number | undefined;
    for (const state of [
      { projects: [], loading: true, error: null },
      { projects: [], loading: false, error: null },
      { projects, loading: false, error: null },
      { projects, loading: true, error: null },
      { projects, loading: false, error: "Storage unavailable" },
    ]) {
      await act(async () => root.render(<LocalProjectsDialog open busy={false} {...state} {...callbacks} />));
      await expect.element(dialog).toBeVisible();
      const bounds = dialog.element().getBoundingClientRect();
      expect(bounds.height).toBe(expected);
      expect(bounds.top).toBeGreaterThanOrEqual(16);
      expect(bounds.bottom).toBeLessThanOrEqual(height - 16);
      const search = dialog.getByRole("textbox", { name: zh ? "搜索项目" : "Search projects", exact: true });
      searchTop ??= search.element().getBoundingClientRect().top;
      expect(search.element().getBoundingClientRect().top).toBe(searchTop);
    }
    const search = dialog.getByRole("textbox", { name: zh ? "搜索项目" : "Search projects", exact: true });
    await act(async () => userEvent.fill(search, "no-matching-project"));
    await expect
      .element(dialog.getByText(zh ? "没有匹配的项目" : "No projects match your search", { exact: true }))
      .toBeVisible();
    expect(dialog.element().getBoundingClientRect().height).toBe(expected);
    expect(search.element().getBoundingClientRect().top).toBe(searchTop);
  },
);

test.each([390, 1440])(
  "pins project search above scrolling rows and layers confirmations correctly at %ipx",
  async (width) => {
    await page.viewport(width, 650);
    const store = createLocalProjectStore();
    for (let index = 0; index < 18; index++) await store.save({ ...emptyDocument(), name: `Library scene ${index}` });
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(<WorkspaceApp projectStore={store} />);
    });
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Projects", exact: true });
    await expect.element(page.getByTestId("local-project-list")).toBeVisible();
    const parentDialog = dialog.element();
    const search = dialog.getByRole("textbox", { name: "Search projects", exact: true }).element();
    const list = page.getByTestId("local-project-list").element().parentElement!;
    const top = search.getBoundingClientRect().top;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    await act(async () => {
      list.scrollTop = list.scrollHeight;
    });
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(search.getBoundingClientRect().top).toBe(top);
    expect(list.contains(search)).toBe(false);
    for (const action of ["Rename", "Delete"] as const) {
      const manage = dialog.getByRole("button", { name: "Manage Library scene 0", exact: true });
      await click(manage);
      await click(page.getByRole("menuitem", { name: action, exact: true }));
      const confirmation = page.getByRole("dialog", {
        name: action === "Rename" ? "Rename project" : "Delete project?",
        exact: true,
      });
      await expect.element(confirmation).toBeVisible();
      const backdrops = [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-backdrop"]')].filter((element) =>
        element.checkVisibility(),
      );
      expect(backdrops).toHaveLength(2);
      const topBackdrop = backdrops
        .sort((a, b) => Number(getComputedStyle(a).zIndex) - Number(getComputedStyle(b).zIndex))
        .at(-1)!;
      expect(Number(getComputedStyle(topBackdrop).zIndex)).toBeGreaterThan(
        Number(getComputedStyle(parentDialog).zIndex),
      );
      expect(Number(getComputedStyle(topBackdrop).zIndex)).toBeLessThan(
        Number(getComputedStyle(confirmation.element()).zIndex),
      );
      const bounds = parentDialog.getBoundingClientRect();
      const layers = document.elementsFromPoint(bounds.left + 8, bounds.top + 8);
      expect(layers).toContain(topBackdrop);
      const input = confirmation.element().querySelector("input");
      if (input) expect(document.activeElement).toBe(input);
      await act(async () => userEvent.keyboard("{Escape}"));
      await expect.element(confirmation).not.toBeInTheDocument();
      await expect.element(dialog).toBeVisible();
      await expect.element(manage).toHaveFocus();
    }
  },
);

test("retains project rows, search and list height throughout automatic refresh and refresh failure", async () => {
  const store = createLocalProjectStore();
  const saved = await store.save({ ...emptyDocument(), name: "Library scene" });
  await act(async () => {
    root.unmount();
    root = createRoot(container);
    root.render(<WorkspaceApp projectStore={store} />);
  });
  await click(page.getByRole("button", { name: "Open projects", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Projects", exact: true });
  const manage = dialog.getByRole("button", { name: "Manage Library scene", exact: true });
  await expect.element(manage).toBeVisible();
  const search = dialog.getByRole("textbox", { name: "Search projects", exact: true });
  await act(async () => userEvent.fill(search, "Library"));
  const row = manage.element();
  const list = page.getByTestId("local-project-list").element();
  const height = list.getBoundingClientRect().height;
  let resolveRefresh!: (projects: Awaited<ReturnType<LocalProjectStore["list"]>>) => void;
  const pendingRefresh = new Promise<Awaited<ReturnType<LocalProjectStore["list"]>>>((resolve) => {
    resolveRefresh = resolve;
  });
  expect(dialog.element().querySelector('[aria-label*="Refresh"]')).toBeNull();
  expect(dialog.element().getAttribute("aria-describedby")).toBeNull();
  const spy = vi.spyOn(store, "list").mockReturnValueOnce(pendingRefresh);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(manage.element()).toBe(row);
  expect(list.getBoundingClientRect().height).toBe(height);
  await expect.element(manage).toBeDisabled();
  await expect.element(search).toHaveValue("Library");
  await act(async () => resolveRefresh([saved]));
  await expect.element(manage).toBeEnabled();
  expect(manage.element()).toBe(row);
  spy.mockRejectedValueOnce(new LocalProjectStorageError("failed", "unavailable"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await expect.element(dialog.getByRole("alert")).toBeVisible();
  expect(manage.element()).toBe(row);
  expect(list.getBoundingClientRect().height).toBe(height);
  await expect.element(search).toHaveValue("Library");
});

test("reports management failures without losing the scene and supports retry", async () => {
  const store = createLocalProjectStore();
  const saved = await store.save({ ...emptyDocument(), name: "Library scene" });
  const rename = vi.spyOn(store, "rename").mockRejectedValueOnce(new LocalProjectStorageError("quota", "full"));
  const remove = vi.spyOn(store, "remove").mockRejectedValueOnce(new LocalProjectStorageError("failed", "denied"));
  await act(async () => {
    root.unmount();
    root = createRoot(container);
    root.render(<WorkspaceApp projectStore={store} />);
  });
  await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeVisible();
  await addPrimitive();
  await click(page.getByRole("button", { name: "Open projects", exact: true }));
  const dialog = page.getByRole("dialog", { name: "Projects", exact: true });
  await click(dialog.getByRole("button", { name: "Manage Library scene", exact: true }));
  await click(page.getByRole("menuitem", { name: "Rename", exact: true }));
  const input = page
    .getByRole("dialog", { name: "Rename project", exact: true })
    .getByRole("textbox", { name: "Project name", exact: true });
  await act(async () => userEvent.fill(input, "Renamed library"));
  await click(
    page
      .getByRole("dialog", { name: "Rename project", exact: true })
      .getByRole("button", { name: "Save", exact: true }),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Browser storage is full. Export a portable copy to keep your work.");
  expect((await store.load(saved.id)).name).toBe("Library scene");
  await expect.element(input).toHaveValue("Renamed library");
  await click(
    page
      .getByRole("dialog", { name: "Rename project", exact: true })
      .getByRole("button", { name: "Save", exact: true }),
  );
  await expect.element(dialog.getByRole("button", { name: "Manage Renamed library", exact: true })).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(rename).toHaveBeenCalledTimes(2);
  expect(document.querySelector(".project-name")!.textContent).toContain("Untitled scene");
  await click(dialog.getByRole("button", { name: "Manage Renamed library", exact: true }));
  await click(page.getByRole("menuitem", { name: "Delete", exact: true }));
  await click(
    page
      .getByRole("dialog", { name: "Delete project?", exact: true })
      .getByRole("button", { name: "Delete", exact: true }),
  );
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(await store.list()).toHaveLength(1);
  await click(
    page
      .getByRole("dialog", { name: "Delete project?", exact: true })
      .getByRole("button", { name: "Delete", exact: true }),
  );
  await expect.element(dialog.getByText("No saved projects in this browser yet", { exact: true })).toBeVisible();
  expect(remove).toHaveBeenCalledTimes(2);
  await click(dialog.getByRole("button", { name: "Close projects", exact: true }));
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeVisible();
});

test("keeps stored project data intact on invalid or missing management operations", async () => {
  const store = createLocalProjectStore();
  try {
    const original = await store.save(emptyDocument());
    const before = await store.load(original.id);
    for (const operation of [
      () => store.rename("missing", "Name"),
      () => store.duplicate("missing", "Copy"),
      () => store.remove("missing"),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "not-found" });
    }
    for (const operation of [() => store.rename(original.id, " "), () => store.duplicate(original.id, " ")]) {
      await expect(operation()).rejects.toMatchObject({ code: "failed" });
    }
    expect(await store.load(original.id)).toEqual(before);
    expect(await store.list()).toEqual([original]);
  } finally {
    store.close?.();
  }
});

test("saves locally and recovers the project after the workspace remounts", async () => {
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
  expect(document.querySelector(".context-copy")!.textContent).not.toContain("saved");
  await expect.element(page.getByRole("status")).toHaveTextContent("");

  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div");
  container.style.height = "100%";
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<WorkspaceApp />));
  await act(async () => {
    await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
  });

  await click(page.getByRole("button", { name: "Open projects" }));
  await expect.element(page.getByRole("dialog", { name: "Projects" })).toBeInTheDocument();
  await expect
    .element(page.getByRole("dialog", { name: "Projects" }).getByText("Untitled scene", { exact: true }))
    .toBeInTheDocument();
  await click(page.getByRole("button", { name: "Open", exact: true }));
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("Saved", { exact: true })).toBeInTheDocument();
});

test("imports a portable native project through the file picker", async () => {
  const processor = createProcessor(emptyDocument());
  processor.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "box", name: "Imported box" },
  });
  const nativeProject = serializeNativeProject({
    ...processor.getDocumentSnapshot(),
    name: "Portable scene",
    workspace: {
      ...processor.getDocumentSnapshot().workspace,
      projection: "orthographic",
      showGrid: false,
    },
  });

  await click(page.getByRole("button", { name: "Import project / GLB / glTF", exact: true }));
  const fileInput = page.getByLabelText("Project or glTF files");
  await act(async () =>
    userEvent.upload(
      fileInput,
      new File([nativeProject], "portable.open3d", {
        type: "application/vnd.open-3d.project+json",
      }),
    ),
  );

  await expect.element(page.getByRole("button", { name: "Imported box", exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("Portable scene", { exact: true })).toBeInTheDocument();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Portable scene imported. Save it to this browser or export a portable copy.");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test.each([
  {
    name: "malformed.open3d",
    content: "{",
    expectedError: "The project file is not valid JSON",
  },
  {
    name: "failed-migration.open3d",
    content: JSON.stringify({ format: "open-3d-project", formatVersion: 0, legacyPayload: {} }),
    expectedError: "missing its modelingDocument payload",
  },
])("keeps the active scene when importing $name fails", async ({ name, content, expectedError }) => {
  await addPrimitive();
  await click(page.getByRole("button", { name: "Import project / GLB / glTF", exact: true }));
  await act(async () =>
    userEvent.upload(
      page.getByLabelText("Project or glTF files"),
      new File([content], name, { type: "application/vnd.open-3d.project+json" }),
    ),
  );

  const dialog = page.getByRole("dialog", { name: "File operation failed" });
  await expect.element(dialog.getByText(expectedError, { exact: false })).toBeInTheDocument();
  await expect
    .element(
      dialog.getByText("Your current scene is unchanged. Choose a valid file or export the current scene", {
        exact: false,
      }),
    )
    .toBeInTheDocument();
  await click(page.getByRole("button", { name: "Close file error" }));
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
});

test("preserves the active scene and offers native recovery when interchange export fails", async () => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    throw new Error("Browser download is unavailable.");
  });
  await addPrimitive();
  await click(page.getByRole("button", { name: "Export", exact: true }));
  await act(async () => {
    await userEvent.click(page.getByRole("menuitem", { name: "GLB", exact: true }));
    await expect
      .element(
        page
          .getByRole("dialog", { name: "File operation failed" })
          .getByText("Could not export as GLB.", { exact: false }),
      )
      .toBeInTheDocument();
  });

  const dialog = page.getByRole("dialog", { name: "File operation failed" });
  await expect
    .element(
      dialog.getByText("Could not export as GLB. Your active project is unchanged.", {
        exact: false,
      }),
    )
    .toBeInTheDocument();
  await expect.element(dialog.getByText("Try exporting a portable open3d copy", { exact: false })).toBeInTheDocument();
  await expect
    .element(dialog.getByRole("button", { name: "Export current project as open3d", exact: true }))
    .toBeInTheDocument();
  await click(dialog.getByRole("button", { name: "Close file error" }));
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
});

test("imports supported glTF content and discloses omitted cameras", async () => {
  const gltf = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ name: "Interchange scene", nodes: [0, 1] }],
    nodes: [
      { name: "Pyramid base", mesh: 0 },
      { name: "Camera", camera: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    cameras: [{ type: "perspective", perspective: { yfov: 0.7, znear: 0.1 } }],
    buffers: [
      {
        byteLength: 36,
        uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA",
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
  });

  await click(page.getByRole("button", { name: "Import project / GLB / glTF" }));
  await act(async () =>
    userEvent.upload(
      page.getByLabelText("Project or glTF files"),
      new File([gltf], "interchange.gltf", { type: "model/gltf+json" }),
    ),
  );

  await expect.element(page.getByRole("button", { name: "Pyramid base", exact: true })).toBeInTheDocument();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Interchange scene imported. Unsupported content omitted: 1 camera(s) were omitted.");
});

test.each([
  { format: "glb", button: "GLB", mimeType: "model/gltf-binary" },
  { format: "gltf", button: "glTF", mimeType: "model/gltf+json" },
])("exchanges a scene through the browser $format workflow", async ({ format, button, mimeType }) => {
  let exportedBlob: Blob | undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
    exportedBlob = object as Blob;
    return `blob:workspace-export.${format}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

  await addPrimitive();
  const objectName = page.getByRole("textbox", { name: "Object name" });
  await act(async () => userEvent.fill(objectName, "Exchange box"));
  await act(async () => userEvent.keyboard("{Enter}"));
  await click(page.getByRole("button", { name: "Export", exact: true }));
  await click(page.getByRole("menuitem", { name: button, exact: true }));

  await expect.element(page.getByRole("status")).toHaveTextContent(`${format.toUpperCase()} downloaded`);
  expect(exportedBlob).toBeInstanceOf(Blob);
  expect(exportedBlob?.type).toBe(mimeType);

  const fileInput = page.getByLabelText("Project or glTF files");
  await act(async () =>
    userEvent.upload(fileInput, new File([exportedBlob!], `exchange.${format}`, { type: mimeType })),
  );
  await expect.element(page.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Discard", exact: true }));

  await expect.element(page.getByRole("button", { name: "Exchange box", exact: true })).toBeInTheDocument();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Untitled scene imported. Save it to this browser or export a portable copy.");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("separates file operations from local project management and explains format boundaries", async () => {
  expect(
    page
      .getByRole("button", { name: "Import project / GLB / glTF", exact: true })
      .element()
      .querySelector(".lucide-download"),
  ).not.toBeNull();
  expect(
    page.getByRole("button", { name: "Export", exact: true }).element().querySelector(".lucide-upload"),
  ).not.toBeNull();
  await click(page.getByRole("button", { name: "Open projects" }));
  const dialog = page.getByRole("dialog", { name: "Projects" });
  await expect.element(dialog.getByRole("button", { name: "Import project / GLB / glTF" })).not.toBeInTheDocument();
  await expect.element(dialog.getByRole("button", { name: "open3d" })).not.toBeInTheDocument();
  await click(dialog.getByRole("button", { name: "Close projects" }));
  await click(page.getByRole("button", { name: "Export", exact: true }));
  const menu = page.getByRole("menu", { name: "Export", exact: true });
  const items = [...menu.element().querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["open3d", "GLB", "glTF"]);
  expect(new Set(items.map((item) => item.getBoundingClientRect().top)).size).toBe(1);
  expect(menu.element().querySelector("p")!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    items[0].getBoundingClientRect().bottom,
  );
  await expect
    .element(menu.getByText("Export open3d for a portable editable project", { exact: false }))
    .toBeInTheDocument();
  await expect
    .element(menu.getByText("does not preserve editor state or unsupported extensions", { exact: false }))
    .toBeInTheDocument();
  await act(async () => userEvent.keyboard("{Escape}"));
});

test.each([
  { width: 390, language: "en", theme: "light" },
  { width: 1440, language: "en", theme: "dark" },
  { width: 390, language: "zh-CN", theme: "dark" },
  { width: 768, language: "zh-CN", theme: "light" },
] as const)("keeps export formats in one row at $width in $language/$theme", async ({ width, language, theme }) => {
  await page.viewport(width, 844);
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ language, theme }));
  const title = language === "en" ? "Export" : "导出";
  await click(page.getByRole("button", { name: title, exact: true }));
  const menu = page.getByRole("menu", { name: title, exact: true });
  await expect.element(menu).toBeVisible();
  await expect.poll(() => menu.element().getAnimations().length).toBe(0);
  const items = [...menu.element().querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["open3d", "GLB", "glTF"]);
  expect(new Set(items.map((item) => item.getBoundingClientRect().top)).size).toBe(1);
  for (const item of items) {
    expect(getComputedStyle(item).borderWidth).toBe("1px");
    expect(getComputedStyle(item).borderColor).toBe(semanticColor("border"));
  }
  for (const [index, icon] of ["file-box", "box", "file-json"].entries()) {
    const svg = items[index].querySelector(`svg.lucide-${icon}`);
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  }
  const bounds = menu.element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  const notice = menu.element().querySelector("p")!;
  expect(notice.textContent).not.toContain(".open3d");
  expect(notice.getBoundingClientRect().top).toBeGreaterThanOrEqual(items[0].getBoundingClientRect().bottom);
  expect(parseFloat(getComputedStyle(notice).fontSize)).toBeLessThan(parseFloat(getComputedStyle(items[0]).fontSize));
  await act(async () => userEvent.keyboard("{Escape}"));
});

test.each([
  { width: 390, language: "en", theme: "light" },
  { width: 1440, language: "zh-CN", theme: "dark" },
] as const)("shares modal chrome without subtitles at $width in $language", async ({ width, language, theme }) => {
  await page.viewport(width, 700);
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ language, theme }));
  const zh = language === "zh-CN";
  let modalRadius: string | undefined;
  async function expectChrome(name: string, compactTitle = false) {
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect.element(dialog).toBeVisible();
    const element = dialog.element();
    const style = getComputedStyle(element);
    expect(style.borderTopWidth).toBe("1px");
    modalRadius ??= style.borderRadius;
    expect(parseFloat(style.borderRadius)).toBeGreaterThan(0);
    expect(style.borderRadius).toBe(modalRadius);
    expect(style.backgroundColor).toBe(semanticColor("sheet"));
    expect(style.boxShadow).not.toBe("none");
    expect(element.getAttribute("aria-describedby")).toBeNull();
    const title = element.querySelector<HTMLElement>('[data-slot="dialog-title"]')!;
    expect(title).not.toBeNull();
    if (compactTitle) expect(title.classList.contains("sr-only")).toBe(true);
    else {
      expect(getComputedStyle(title).fontSize).toBe("16px");
      expect(getComputedStyle(title).fontWeight).toBe("600");
    }
    const bounds = element.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(16);
    expect(bounds.right).toBeLessThanOrEqual(width - 16);
    return dialog;
  }
  await addPrimitive();
  await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
  await click(page.getByRole("button", { name: zh ? "打开项目" : "Open projects", exact: true }));
  const manager = await expectChrome(zh ? "项目" : "Projects");
  expect(manager.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(360);
  const manage = manager.getByRole("button", { name: /^(Manage |管理 )/ });
  await click(manage);
  await click(page.getByRole("menuitem", { name: zh ? "重命名" : "Rename", exact: true }));
  await expectChrome(zh ? "重命名项目" : "Rename project", true);
  await click(page.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
  await click(manage);
  await click(page.getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true }));
  const remove = await expectChrome(zh ? "删除项目？" : "Delete project?");
  await expect
    .element(
      remove.getByText(
        zh ? "删除后无法恢复，请谨慎操作。" : "Deletion cannot be undone. Please proceed with caution.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await click(page.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
  await click(page.getByRole("button", { name: zh ? "关闭项目" : "Close projects", exact: true }));
  await openAISettings();
  const settings = await expectChrome(zh ? "AI 服务设置" : "AI provider settings");
  await expect
    .element(settings.getByText(zh ? "本地配置与请求隐私" : "Local settings and request privacy", { exact: true }))
    .toBeVisible();
  await click(page.getByRole("button", { name: zh ? "关闭 AI 服务设置" : "Close AI provider settings", exact: true }));
  await click(page.getByRole("button", { name: zh ? "关闭 AI 对话" : "Close AI chat", exact: true }));
  await addPrimitive("cylinder");
  await act(async () =>
    userEvent.upload(
      page.getByLabelText(zh ? "项目或 glTF 文件" : "Project or glTF files"),
      new File([serializeNativeProject(emptyDocument())], "replacement.open3d", {
        type: "application/vnd.open-3d.project+json",
      }),
    ),
  );
  await expectChrome(zh ? "未保存的更改" : "Unsaved changes");
  await click(page.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
});

test.each([
  { width: 390, language: "en", theme: "light" },
  { width: 1440, language: "en", theme: "dark" },
  { width: 390, language: "zh-CN", theme: "dark" },
  { width: 1440, language: "zh-CN", theme: "light" },
] as const)(
  "keeps compact AI and tool chrome consistent at $width in $language/$theme",
  async ({ width, language, theme }) => {
    await page.viewport(width, 844);
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ language, theme }));
    const zh = language === "zh-CN";
    const quick = document.querySelector(".quick-tools")!.getBoundingClientRect();
    const transform = document.querySelector(".transform-tools")!.getBoundingClientRect();
    expect(quick.height).toBe(transform.height);
    if (width > 600) expect(quick.top).toBe(transform.top);
    const launcher = page.getByRole("button", { name: zh ? "AI 对话" : "AI chat", exact: true });
    expect(launcher.element().getBoundingClientRect().width).toBe(44);
    expect(launcher.element().getBoundingClientRect().height).toBe(44);
    await click(launcher);
    await expect
      .element(page.getByText(zh ? "描述你想创造的模型" : "Describe the model you want to create", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true }))
      .toHaveAttribute("placeholder", zh ? "和 AI 一起建模" : "Model with AI");
    await openAISettings();
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI provider settings", exact: true });
    await expect.element(dialog.getByRole("textbox", { name: "URL", exact: true })).toBeVisible();
    expect(dialog.element().querySelector('label[for="ai-api-key"] svg')).toBeNull();
    await act(async () =>
      userEvent.fill(dialog.getByRole("textbox", { name: "URL", exact: true }), "https://models.example.test/v1"),
    );
    await act(async () =>
      userEvent.fill(dialog.getByRole("textbox", { name: zh ? "模型" : "Model", exact: true }), "test-model"),
    );
    await act(async () =>
      userEvent.fill(dialog.getByLabelText(zh ? "API 密钥" : "API key", { exact: false }), "test-key"),
    );
    await click(dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    expect(loadAIProviderSettings()?.apiKey).toBe("test-key");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("region", { name: zh ? "AI 对话" : "AI conversation", exact: true }))
      .toBeVisible();
    await openAISettings();
    await expect
      .element(dialog.getByRole("textbox", { name: "URL", exact: true }))
      .toHaveValue("https://models.example.test/v1");
    await expect
      .element(dialog.getByRole("textbox", { name: zh ? "模型" : "Model", exact: true }))
      .toHaveValue("test-model");
    await click(dialog.getByRole("button", { name: zh ? "移除保存的 API 密钥" : "Remove saved API key", exact: true }));
    expect(loadAIProviderSettings()).toEqual({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      apiKey: undefined,
    });
    expect(dialog.element().querySelector('[role="status"]')).toBeNull();
  },
);

test("validates provider settings by field and saves usable configuration locally", async () => {
  await openAISettings();
  const dialog = page.getByRole("dialog", { name: "AI provider settings" });
  await click(dialog.getByRole("button", { name: "Save" }));

  await expect.element(page.getByText("Enter an endpoint URL", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("Enter a model identifier", { exact: true })).toBeInTheDocument();
  expect(localStorage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY)).toBeNull();

  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "URL" }), "not a URL"));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Model" }), "test-model"));
  await click(dialog.getByRole("button", { name: "Save" }));
  await expect.element(page.getByText("Enter a valid absolute HTTP or HTTPS URL", { exact: true })).toBeInTheDocument();
  expect(localStorage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY)).toBeNull();

  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "URL" }), "https://models.example.test/v1/"));
  await click(dialog.getByRole("button", { name: "Save" }));
  await expect.element(dialog).not.toBeInTheDocument();
  expect(loadAIProviderSettings()).toEqual({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: undefined,
  });
  await openAISettings();
  await expect.element(dialog.getByText(/Please ensure your current environment is secure/)).toBeInTheDocument();
});

test.each(["en", "zh-CN"] as const)(
  "keeps failed AI settings saves open and closes after retry in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    const zh = language === "zh-CN";
    const original = {
      protocol: "openai-compatible" as const,
      baseURL: "https://old.example.test/v1",
      modelId: "old-model",
    };
    saveAIProviderSettings(original);
    await openAISettings();
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI provider settings", exact: true });
    const model = dialog.getByRole("textbox", { name: zh ? "模型" : "Model", exact: true });
    await act(async () => userEvent.fill(model, "new-model"));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    await click(dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByRole("alert")).toBeVisible();
    await expect.element(model).toHaveValue("new-model");
    expect(loadAIProviderSettings()).toEqual(original);
    write.mockRestore();
    await click(dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    await expect.element(dialog).not.toBeInTheDocument();
    expect(loadAIProviderSettings()).toEqual({ ...original, modelId: "new-model" });
    await expect
      .element(page.getByRole("region", { name: zh ? "AI 对话" : "AI conversation", exact: true }))
      .toBeVisible();
  },
);

test("directs unconfigured AI prompts to provider settings without sending a request", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  expect(document.querySelector(".ai-endpoint-disclosure")).toBeNull();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a cube"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect.element(page.getByRole("dialog", { name: "AI provider settings" })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("cancels an in-flight request without applying unconfirmed edits", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await click(page.getByRole("button", { name: "Cancel request" }));

  await expect
    .element(page.getByRole("region", { name: "AI conversation", exact: true }).getByRole("status").last())
    .toHaveTextContent("Request cancelled");
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("retains streamed assistant text after cancellation and includes it in the next request", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const partial = "I will build the table with four legs.";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            id: "partial",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta: { content: partial }, finish_reason: null }],
          })}\n\n`,
        ),
      );
    },
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    .mockResolvedValueOnce(chatTextResponse("continue", "Continuing the table."));
  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a table"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Cancel request" }));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Continue"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Continuing the table.", { exact: true })).toBeVisible();
  expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).messages).toEqual([
    { role: "user", content: "Build a table" },
    { role: "assistant", content: partial },
    { role: "user", content: "Continue" },
  ]);
});

test("automatically scrolls long modeling proposals without a request destination notice", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: `https://models.example.test/${"long-endpoint/".repeat(12)}v1`,
    modelId: "test-model",
  });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  for (let index = 0; index < 8; index++) {
    fetchMock.mockResolvedValueOnce(
      chatToolCallResponse(`box-${index}`, "command_scene_createPrimitive", {
        primitive: "box",
        name: `Table component ${index}`,
      }),
    );
  }
  fetchMock.mockResolvedValueOnce(chatTextResponse("ready", "All components are ready."));
  await page.viewport(390, 844);
  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  expect(document.querySelector(".ai-endpoint-disclosure")).toBeNull();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a table"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeInTheDocument();
  const list = document.querySelector<HTMLElement>("[data-ai-proposals]")!;
  expect(list.children).toHaveLength(8);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(list.scrollHeight - list.clientHeight - list.scrollTop).toBeLessThanOrEqual(1);
  const transcript = document.querySelector<HTMLElement>(".ai-transcript")!;
  expect(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop).toBeLessThanOrEqual(1);
});

test("previews a multi-step AI model operation on the canvas until accepted", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      chatToolCallResponse("create-table", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Table top",
      }),
    )
    .mockResolvedValueOnce(chatTextResponse("table-summary", "The table is ready for review."))
    .mockResolvedValueOnce(chatTextResponse("table-complete", "The table task is complete."));

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a table."));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect.element(page.getByText("The table is ready for review.")).toBeInTheDocument();
  await expect.element(page.getByText("AI preview · not applied")).toBeInTheDocument();
  await expect.element(page.getByText(/Previewing 1 proposed change on the canvas/)).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await click(page.getByRole("button", { name: "Accept changes" }));
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("AI preview · not applied")).not.toBeInTheDocument();
  await expect.element(page.getByText("Applied as one undoable action. Use Undo to revert.")).toBeInTheDocument();
  await expect.element(page.getByText("The table task is complete.")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(useWorkspaceUiStore.getState().notice).toBe("");
});

test("continues an approved modeling task and stops when the user rejects a later proposal", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      chatToolCallResponse("table-top", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Table top",
      }),
    )
    .mockResolvedValueOnce(chatTextResponse("table-top-summary", "The tabletop is ready."))
    .mockResolvedValueOnce(
      chatToolCallResponse("table-legs", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Table leg",
      }),
    )
    .mockResolvedValueOnce(chatTextResponse("table-legs-summary", "The table structure is ready."));

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a table."));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await click(page.getByRole("button", { name: "Accept changes" }));

  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();
  const nextProposal = page.getByRole("region", { name: "Proposed modeling changes" }).last();
  await expect
    .element(nextProposal.getByText("Previewing 1 proposed change on the canvas", { exact: true }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table leg", exact: true })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  const [, continuationInit] = fetchMock.mock.calls[2]!;
  const continuationBody = JSON.parse(continuationInit?.body as string);
  expect(continuationBody.messages.at(-1).content).toContain("Continue the original modeling task");
  expect(continuationBody.messages.at(-1).content).toContain("user approved and applied");

  await click(nextProposal.getByRole("button", { name: "Reject" }));
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table leg", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("Proposal rejected. This batch was not applied.").last()).toBeInTheDocument();
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
});

test("rejecting an AI proposal removes the canvas preview without changing the scene", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(chatToolCallResponse("create-box", "command_scene_createPrimitive", { primitive: "box" }))
    .mockResolvedValueOnce(chatTextResponse("box-summary", "A box is ready for review."));

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box."));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("AI preview · not applied")).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Reject" }));

  await expect.element(page.getByText("AI preview · not applied")).not.toBeInTheDocument();
  expect(document.querySelector(".viewport-empty")).toBeNull();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  await expect.element(page.getByText("Proposal rejected. This batch was not applied.")).toBeInTheDocument();
});

test("recovers from provider authentication errors and keeps the prompt available to resend", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: "invalid-key",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }))
    .mockResolvedValueOnce(
      new Response(
        [
          'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-retry","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect
    .element(page.getByRole("alert").getByText("The provider rejected the request. Check the endpoint and API key."))
    .toBeInTheDocument();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Add a box");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Recovered", { exact: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each([
  {
    label: "network",
    respond: () => Promise.reject(new TypeError("Failed to fetch")),
    expectedError: /Could not reach the provider/,
  },
  {
    label: "tool protocol",
    respond: () =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-invalid-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-invalid-command","type":"function","function":{"name":"command_scene_createPrimitive","arguments":"{\\"primitive\\":\\"torus\\"}"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chatcmpl-invalid-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    expectedError: /incompatible response/,
  },
])("$label failure preserves the scene and provides a resend path", async ({ respond, expectedError }) => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(respond);
  await addPrimitive();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a sphere"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect
    .element(page.getByRole("region", { name: "AI conversation", exact: true }).getByRole("status").last())
    .toHaveTextContent("Request failed");
  await expect.element(page.getByRole("alert").getByText(expectedError)).toBeInTheDocument();
  await expect.element(page.getByText(/Correct settings if needed, then resend/)).toBeInTheDocument();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Add a sphere");
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Undo" })).toBeEnabled();
});

test("removes the saved API key and sends the next request without credentials", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: "remove-me",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        [
          'data: {"id":"chatcmpl-no-key","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"No key sent"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-no-key","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  await openAISettings();
  const dialog = page.getByRole("dialog", { name: "AI provider settings" });
  await click(dialog.getByRole("button", { name: "Remove saved API key" }));
  expect(dialog.element().querySelector('[role="status"]')).toBeNull();
  await expect.element(dialog.getByRole("button", { name: "Remove saved API key" })).not.toBeInTheDocument();
  expect(loadAIProviderSettings()?.apiKey).toBeUndefined();

  await click(dialog.getByRole("button", { name: "Close AI provider settings" }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Check credentials"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("No key sent", { exact: true })).toBeInTheDocument();

  const [, requestInit] = fetchMock.mock.calls[0]!;
  expect(new Headers(requestInit?.headers).has("authorization")).toBe(false);
});

test("streams text responses directly to the configured provider without a destination notice", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"A cube"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":" is ready."},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  expect(document.querySelector(".ai-endpoint-disclosure")).toBeNull();
  await expect.element(page.getByText("Request destination", { exact: true })).not.toBeInTheDocument();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a cube"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect.element(page.getByText("A cube is ready.", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("Response complete", { exact: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
  const endpoint =
    requestUrl instanceof Request ? requestUrl.url : requestUrl instanceof URL ? requestUrl.href : requestUrl;
  expect(endpoint).toBe("https://models.example.test/v1/chat/completions");
  expect(typeof requestInit?.body).toBe("string");
  const body = JSON.parse(requestInit?.body as string);
  expect(body.messages).toEqual([{ role: "user", content: "Add a cube" }]);
  expect(body.tools).toHaveLength(MODELING_COMMANDS.length + MODELING_QUERIES.length);
  expect(body.tools.map((entry: { function: { name: string } }) => entry.function.name)).toContain(
    "command_scene_createPrimitive",
  );
  expect(body.tools.map((entry: { function: { name: string } }) => entry.function.name)).toContain(
    "query_scene_getHierarchy",
  );
  const hierarchyTool = body.tools.find(
    (entry: { function: { name: string } }) => entry.function.name === "query_scene_getHierarchy",
  );
  expect(hierarchyTool.function.parameters.properties.limit.maximum).toBe(1000);
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
});

test.each([
  { action: "rejects", decision: "Reject", expectedObjects: 0 },
  { action: "accepts and undoes", decision: "Accept changes", expectedObjects: 2 },
])("AI proposal $action without bypassing command history", async ({ decision, expectedObjects }) => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        [
          'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-create-box","type":"function","function":{"name":"command_scene_createPrimitive","arguments":"{\\"primitive\\":\\"box\\",\\"name\\":\\"AI box\\"}"}},{"index":1,"id":"call-create-sphere","type":"function","function":{"name":"command_scene_createPrimitive","arguments":"{\\"primitive\\":\\"uv-sphere\\",\\"name\\":\\"AI sphere\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    .mockResolvedValueOnce(chatTextResponse("tool-summary", "The scene is ready."))
    .mockResolvedValueOnce(chatTextResponse("task-complete", "The requested task is complete."));

  await click(page.getByRole("button", { name: "AI chat", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  const proposal = page.getByRole("region", { name: "Proposed modeling changes" });
  await expect
    .element(proposal.getByText("Previewing 2 proposed changes on the canvas", { exact: true }))
    .toBeInTheDocument();
  await expect.element(proposal.getByText('{"primitive":"box","name":"AI box"}', { exact: true })).toBeInTheDocument();
  await expect
    .element(proposal.getByText('{"primitive":"uv-sphere","name":"AI sphere"}', { exact: true }))
    .toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await click(proposal.getByRole("button", { name: decision }));

  if (decision === "Accept changes") {
    await expect.element(proposal.getByText(/Applied as one undoable action/)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "AI box", exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "AI sphere", exact: true })).toBeInTheDocument();
    await click(page.getByRole("button", { name: "Undo" }));
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  } else {
    await expect
      .element(proposal.getByText("Proposal rejected. This batch was not applied.", { exact: true }))
      .toBeInTheDocument();
  }
  expect(document.querySelectorAll(".object-row")).toHaveLength(decision === "Accept changes" ? 0 : expectedObjects);
  await expect.element(page.getByRole("button", { name: "AI box", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "AI sphere", exact: true })).not.toBeInTheDocument();
});

test("protects unsaved work when importing a replacement project", async () => {
  const replacement = createProcessor();
  replacement.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "uv-sphere", name: "Imported sphere" },
  });
  async function importReplacement() {
    await act(async () =>
      userEvent.upload(
        page.getByLabelText("Project or glTF files"),
        new File([serializeNativeProject(replacement.getDocumentSnapshot())], "replacement.open3d", {
          type: "application/vnd.open-3d.project+json",
        }),
      ),
    );
  }
  await addPrimitive();
  await importReplacement();
  await expect.element(page.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();

  await importReplacement();
  await click(page.getByRole("button", { name: "Discard", exact: true }));
  await expect.element(page.getByRole("button", { name: "Imported sphere", exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).not.toBeInTheDocument();

  await addPrimitive("cylinder");
  await importReplacement();
  await expect.element(page.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Save and continue", exact: true }));
  await expect.element(page.getByRole("button", { name: "Imported sphere", exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Cylinder", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("Unsaved changes", { exact: true })).toBeInTheDocument();
  const store = createLocalProjectStore();
  try {
    const [saved] = await store.list();
    expect((await store.load(saved!.id)).objects.map(({ name }) => name)).toEqual(["Imported sphere", "Cylinder"]);
  } finally {
    store.close?.();
  }
});

test.each([
  { code: "unavailable" as const, label: "denied browser storage" },
  { code: "quota" as const, label: "storage quota exhaustion" },
])("offers portable export after $label", async ({ code }) => {
  await act(async () => {
    root.unmount();
    container.remove();
    container = document.createElement("div");
    container.style.height = "100%";
    document.body.append(container);
    root = createRoot(container);
    root.render(<WorkspaceApp projectStore={failingProjectStore(code)} />);
  });
  await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));

  await expect
    .element(
      page
        .getByRole("alert")
        .getByText(
          code === "quota"
            ? "Browser storage is full. Export a portable copy to keep your work."
            : "Browser storage is unavailable. Export a portable copy to keep your work.",
          {
            exact: true,
          },
        ),
    )
    .toBeInTheDocument();
  await click(page.getByRole("button", { name: "Close projects" }));
  await expect.element(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
});
test("switches workspace labels and accessible names without remounting the scene", async () => {
  await addPrimitive();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Object name" }), "My 桌子"));
  await act(async () => userEvent.keyboard("{Enter}"));
  const canvas = document.querySelector("canvas");
  await click(page.getByRole("button", { name: "Language", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "简体中文", exact: true }));

  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.querySelector("canvas")).toBe(canvas);
  await expect.element(page.getByRole("region", { name: "3D 视口" })).toBeVisible();
  await expect.element(page.getByRole("application", { name: "交互式 3D 场景" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "物体", exact: true })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "物体名称" })).toHaveValue("My 桌子");
  await expect.element(page.getByRole("button", { name: "隐藏 My 桌子" })).toBeVisible();
  await expect.element(page.getByRole("spinbutton", { name: "位置 X" })).toBeVisible();
  await click(page.getByRole("button", { name: "语言", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "English", exact: true }));
  await expect.element(page.getByRole("button", { name: "Toggle Transform section", exact: true })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Object name" })).toHaveValue("My 桌子");
  expect(document.querySelector("canvas")).toBe(canvas);
});

test("updates system preferences live and keeps explicit language overrides", async () => {
  let languages = ["en-US"];
  let prefersDark = false;
  let themeListener = () => {};
  let languageListener = () => {};
  const controller = initializeWorkspacePreferences(document.documentElement, null, {
    prefersDark: () => prefersDark,
    languages: () => languages,
    subscribeTheme: (listener) => {
      themeListener = listener;
      return () => {
        themeListener = () => {};
      };
    },
    subscribeLanguage: (listener) => {
      languageListener = listener;
      return () => {
        languageListener = () => {};
      };
    },
  });
  await act(async () => useWorkspaceUiStore.getState().setPreferenceController(controller));
  languages = ["zh-CN"];
  await act(async () => languageListener());
  await expect.element(page.getByRole("button", { name: "主题", exact: true })).toBeVisible();
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "system", language: "en" }));
  prefersDark = true;
  await act(async () => themeListener());
  expect(document.documentElement.dataset.theme).toBe("dark");
  await expect.element(page.getByRole("button", { name: "Theme", exact: true })).toBeVisible();
  languages = ["zh-TW"];
  await act(async () => languageListener());
  expect(document.documentElement.lang).toBe("en");
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language: "en" }));
  await act(async () => themeListener());
  expect(document.documentElement.dataset.theme).toBe("light");
  controller.unsubscribe();
});
test("localizes object creation, unsaved flows, AI validation and asynchronous failures", async () => {
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language: "zh-CN" }));
  await addPrimitive();
  await expect.element(page.getByRole("button", { name: "立方体", exact: true })).toBeVisible();
  await act(async () =>
    userEvent.upload(
      page.getByLabelText("项目或 glTF 文件"),
      new File([serializeNativeProject(emptyDocument())], "replacement.open3d", {
        type: "application/vnd.open-3d.project+json",
      }),
    ),
  );
  await expect.element(page.getByRole("dialog", { name: "未保存的更改" })).toBeVisible();
  await click(page.getByRole("button", { name: "取消", exact: true }));
  await click(page.getByRole("button", { name: "打开项目" }));
  await expect
    .element(page.getByRole("dialog", { name: "项目" }).getByText("此浏览器中尚无已保存的项目", { exact: true }))
    .toBeVisible();
  await click(page.getByRole("button", { name: "关闭项目" }));
  await openAISettings();
  await click(
    page.getByRole("dialog", { name: "AI 服务设置", exact: true }).getByRole("button", { name: "保存", exact: true }),
  );
  await expect.element(page.getByText("请输入端点 URL", { exact: true })).toBeVisible();
  await expect.element(page.getByText("请输入模型标识", { exact: true })).toBeVisible();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "URL" }), "https://models.example.test/v1"));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "模型", exact: true }), "user-model-name"));
  await click(
    page.getByRole("dialog", { name: "AI 服务设置", exact: true }).getByRole("button", { name: "保存", exact: true }),
  );
  expect(loadAIProviderSettings()?.modelId).toBe("user-model-name");
  await expect.element(page.getByRole("dialog", { name: "AI 服务设置", exact: true })).not.toBeInTheDocument();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "消息" }), "Build my 自定义桌子"));
  await click(page.getByRole("button", { name: "发送提示词" }));
  await expect
    .element(
      page.getByRole("alert").getByText("无法连接服务，请检查端点、网络连接和服务的 CORS 设置。", { exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "消息" })).toHaveValue("Build my 自定义桌子");
  await expect.element(page.getByText("user-model-name", { exact: true })).toBeVisible();
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language: "en" }));
  await expect
    .element(
      page
        .getByRole("alert")
        .getByText(
          "Could not reach the provider. Check the endpoint, network connection, and provider CORS settings.",
          {
            exact: true,
          },
        ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Build my 自定义桌子");
  await expect.element(page.getByRole("button", { name: "立方体", exact: true })).toBeVisible();
});
test.each(["light", "dark"] as const)(
  "uses semantic surfaces and accessible controls in the %s theme",
  async (theme) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language: "en" }));
    const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
    const color = (selector: string) => getComputedStyle(element(selector)).backgroundColor;
    const rootStyle = getComputedStyle(document.documentElement);
    const toRgb = (value: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value;
      document.body.append(probe);
      const rgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return rgb;
    };
    expect(color(".studio")).toBe(toRgb(rootStyle.getPropertyValue("--ground")));
    expect(color(".center-stage")).toBe(toRgb(rootStyle.getPropertyValue("--sheet")));
    expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark");
    await addPrimitive();
    expect(getComputedStyle(element(".object-row.selected")).backgroundColor).toBe(
      toRgb(rootStyle.getPropertyValue("--selection")),
    );
    await openAISettings();
    expect(
      getComputedStyle(page.getByRole("dialog", { name: "AI provider settings", exact: true }).element())
        .backgroundColor,
    ).toBe(toRgb(rootStyle.getPropertyValue("--sheet")));
    await expect.element(page.getByRole("textbox", { name: "URL" })).toBeVisible();
    await click(page.getByRole("button", { name: "Close AI provider settings" }));
    await click(page.getByRole("button", { name: "Close AI chat", exact: true }));
    expect(document.querySelector("#viewport-navigation-help")).toBeNull();
  },
);
test("preserves canvas geometry, draft and property editing while the AI floating window opens and closes", async () => {
  await addPrimitive();
  const canvas = document.querySelector("canvas")!;
  const before = canvas.getBoundingClientRect().toJSON();
  expect(document.querySelector('[data-testid="topbar"]')!.textContent).not.toContain("AI");
  await expect.element(page.getByRole("button", { name: "Open AI provider settings" })).not.toBeInTheDocument();
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await click(toggle);
  const dialog = page.getByRole("dialog", { name: "AI chat", exact: true });
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().getAttribute("aria-modal")).not.toBe("true");
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(before);
  await expect.element(page.getByRole("textbox", { name: "Object name" })).toBeVisible();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Keep this draft"));
  await click(page.getByRole("button", { name: "Close AI chat", exact: true }));
  await expect.element(page.getByTestId("ai-floating-dialog")).not.toBeVisible();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Object name" }), "Still editable"));
  await act(async () => userEvent.keyboard("{Enter}"));
  await click(toggle);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
  expect(document.querySelector("canvas")).toBe(canvas);
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(before);
  // Nonmodal chat must remain open when the user interacts with the scene.
  await addPrimitive();
  await expect.element(dialog).toBeVisible();
  await act(async () => page.getByRole("textbox", { name: "Message" }).element().focus());
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(page.getByTestId("ai-floating-dialog")).not.toBeVisible();
  expect(document.activeElement).toBe(toggle.element());
});

test("drags the global AI launcher without opening chat or changing the canvas", async () => {
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  const before = toggle.element().getBoundingClientRect();
  const canvas = document.querySelector("canvas")!;
  const canvasBounds = canvas.getBoundingClientRect().toJSON();
  await act(async () => userEvent.dragAndDrop(toggle, page.getByRole("heading", { name: "Objects", exact: true })));
  const after = toggle.element().getBoundingClientRect();
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.y).toBeLessThan(before.y - 100);
  expect(after.x).toBeGreaterThanOrEqual(16);
  await expect.element(page.getByRole("dialog", { name: "AI chat", exact: true })).not.toBeInTheDocument();
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(canvasBounds);
  await click(toggle);
  await expect.element(page.getByRole("dialog", { name: "AI chat", exact: true })).toBeVisible();
});

test("repositions the floating AI launcher with keyboard controls and clamps it after resize", async () => {
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  const before = toggle.element().getBoundingClientRect();
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
  });
  const moved = toggle.element().getBoundingClientRect();
  expect(moved.x).toBe(before.x - 10);
  expect(moved.y).toBe(before.y - 10);
  await expect.element(page.getByRole("dialog", { name: "AI chat", exact: true })).not.toBeInTheDocument();
  await page.viewport(390, 500);
  await expect.poll(() => toggle.element().getBoundingClientRect().right).toBeLessThanOrEqual(390 - 16);
  expect(toggle.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(500 - 16);
  await click(toggle);
  const bounds = page.getByRole("dialog", { name: "AI chat", exact: true }).element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  const composer = page.getByRole("textbox", { name: "Message" }).element().getBoundingClientRect();
  expect(composer.bottom).toBeLessThanOrEqual(bounds.bottom);
});

test.each([
  { width: 1440, horizontal: "Left", vertical: "Up" },
  { width: 1440, horizontal: "Right", vertical: "Up" },
  { width: 1440, horizontal: "Left", vertical: "Down" },
  { width: 1440, horizontal: "Right", vertical: "Down" },
  { width: 390, horizontal: "Left", vertical: "Up" },
  { width: 390, horizontal: "Right", vertical: "Down" },
])(
  "anchors AI chat beside the $horizontal/$vertical corner at $width without clipping",
  async ({ width, horizontal, vertical }) => {
    await page.viewport(width, 844);
    const toggle = page.getByRole("button", { name: "AI chat", exact: true });
    await act(async () => {
      toggle.element().focus();
      await userEvent.keyboard(`{Shift>}{Arrow${horizontal}>40/}{Arrow${vertical}>30/}{/Shift}`);
    });
    await click(toggle);
    const anchor = toggle.element().getBoundingClientRect();
    const dialog = page.getByTestId("ai-floating-dialog").element();
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(15.5);
    expect(bounds.top).toBeGreaterThanOrEqual(15.5);
    expect(bounds.right).toBeLessThanOrEqual(width - 15.5);
    expect(bounds.bottom).toBeLessThanOrEqual(844 - 15.5);
    const direction = dialog.getAttribute("data-placement")!.split("-")[0];
    const gap = {
      top: anchor.top - bounds.bottom,
      bottom: bounds.top - anchor.bottom,
      left: anchor.left - bounds.right,
      right: bounds.left - anchor.right,
    }[direction]!;
    expect(gap).toBeCloseTo(12, 0);
    expect(bounds.width).toBeGreaterThanOrEqual(Math.min(300, width - 32));
    expect(bounds.height).toBeGreaterThan(200);
  },
);

test("keeps open chat anchored during launcher dragging, keyboard movement and viewport resize", async () => {
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await click(toggle);
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Follow this draft"));
  const canvas = document.querySelector("canvas")!;
  const canvasBounds = canvas.getBoundingClientRect().toJSON();
  const dialog = page.getByTestId("ai-floating-dialog").element();
  const before = dialog.getBoundingClientRect();
  await act(async () => userEvent.dragAndDrop(toggle, page.getByRole("heading", { name: "Objects", exact: true })));
  await act(async () => {
    await expect.poll(() => dialog.getBoundingClientRect().x).toBeLessThan(before.x - 100);
  });
  await settleAIPosition();
  const afterDrag = dialog.getBoundingClientRect();
  const followAxis = /^(left|right)-/.test(dialog.getAttribute("data-placement")!) ? "x" : "y";
  expect(afterDrag.x).toBeLessThan(before.x - 100);
  expect(dialog.getAttribute("data-open")).not.toBeNull();
  const anchorBefore = toggle.element().getBoundingClientRect();
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
  });
  await act(async () => {
    await expect.poll(() => dialog.getBoundingClientRect()[followAxis]).toBeCloseTo(afterDrag[followAxis] + 10, 0);
  });
  expect(toggle.element().getBoundingClientRect().x).toBe(anchorBefore.x + 10);
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(canvasBounds);
  await page.viewport(390, 500);
  await expect
    .poll(() => {
      const bounds = dialog.getBoundingClientRect();
      return bounds.left >= 15.5 && bounds.top >= 15.5 && bounds.right <= 374.5 && bounds.bottom <= 484.5;
    })
    .toBe(true);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Follow this draft");
  const composer = page.getByRole("textbox", { name: "Message" }).element().getBoundingClientRect();
  expect(composer.bottom).toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom);
});

test("keeps centrally anchored chat readable on a short narrow viewport", async () => {
  await page.viewport(390, 500);
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowLeft>4/}{ArrowUp>5/}{/Shift}");
  });
  await click(toggle);
  const bounds = page.getByTestId("ai-floating-dialog").element().getBoundingClientRect();
  expect(bounds.width).toBeGreaterThanOrEqual(300);
  const composer = page.getByRole("textbox", { name: "Message" }).element().getBoundingClientRect();
  expect(composer.top).toBeGreaterThanOrEqual(bounds.top);
  expect(composer.bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(composer.height).toBeGreaterThanOrEqual(40);
});

test("does not flicker between vertical and horizontal placements during a native drag across the side-fit boundary", async () => {
  await page.viewport(900, 1000);
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard(
      "{Shift>}{ArrowLeft>40/}{ArrowRight>10/}{ArrowUp>40/}{ArrowDown>11/}{/Shift}{ArrowRight>2/}{ArrowDown}",
    );
  });
  await click(toggle);
  const dialog = page.getByTestId("ai-floating-dialog").element();
  expect(dialog.getAttribute("data-placement")).toBe("bottom-end");
  const session = cdp();
  const { result } = await session.send("Runtime.evaluate", {
    expression:
      'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
    returnByValue: true,
  });
  const iframe = JSON.parse(result.value as string) as { x: number; y: number };
  const anchor = toggle.element().getBoundingClientRect();
  const mouse = (x: number) => ({ x: iframe.x + x + anchor.width / 2, y: iframe.y + anchor.y + anchor.height / 2 });
  const changes: string[] = [];
  const observer = new MutationObserver(() => changes.push(dialog.getAttribute("data-placement")!));
  observer.observe(dialog, { attributes: true, attributeFilter: ["data-placement"] });
  try {
    await act(async () => {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...mouse(anchor.x) });
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...mouse(anchor.x),
        button: "left",
        clickCount: 1,
      });
    });
    for (const [x, expected] of [
      [450, "bottom-end"],
      [447, "bottom-end"],
      [449, "bottom-end"],
      [460, "bottom-end"],
      [481, "left-end"],
      [479, "left-end"],
      [449, "left-end"],
      [450, "left-end"],
      [447, "bottom-end"],
      [450, "bottom-end"],
      [449, "bottom-end"],
    ] as const) {
      await act(async () =>
        session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...mouse(x), button: "left", buttons: 1 }),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
      expect(toggle.element().getBoundingClientRect().x).toBe(x);
      expect(dialog.getAttribute("data-placement")).toBe(expected);
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(16);
      expect(bounds.right).toBeLessThanOrEqual(884);
      expect(bounds.width).toBe(420);
    }
    expect(changes).toEqual(["left-end", "bottom-end"]);
    await expect.element(page.getByRole("dialog", { name: "AI chat", exact: true })).toBeVisible();
  } finally {
    observer.disconnect();
    await act(async () =>
      session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse(449), button: "left", clickCount: 1 }),
    );
  }
});

test("retains vertical placement around the center line until the opposite side has meaningfully more room", async () => {
  await page.viewport(390, 1000);
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard("{Shift>}{ArrowLeft>40/}{ArrowRight>4/}{ArrowUp>40/}{ArrowDown>11/}{/Shift}{ArrowDown}");
  });
  await click(toggle);
  const dialog = page.getByTestId("ai-floating-dialog").element();
  expect(dialog.getAttribute("data-placement")).toBe("bottom-end");
  for (const [keys, expected] of [
    ["{ArrowDown}", "bottom-end"],
    ["{ArrowUp}", "bottom-end"],
    ["{ArrowDown>3/}", "top-end"],
    ["{ArrowUp>3/}", "top-end"],
    ["{ArrowUp>3/}", "bottom-end"],
  ]) {
    await act(async () => {
      toggle.element().focus();
      await userEvent.keyboard(keys);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(dialog.getAttribute("data-placement")).toBe(expected);
  }
});

test("animates chat entry and exit, preserves rapid reopening and honors reduced motion", async () => {
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  await click(toggle);
  const dialog = page.getByTestId("ai-floating-dialog").element();
  expect(getComputedStyle(dialog).transitionProperty).toBe("opacity, scale");
  expect(parseFloat(getComputedStyle(dialog).transitionDuration)).toBeGreaterThan(0);
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Preserved through transition"));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Close AI chat", exact: true })));
  expect(dialog.hasAttribute("data-ending-style")).toBe(true);
  expect(dialog.hasAttribute("hidden")).toBe(false);
  await expect.poll(() => dialog.getAnimations().length).toBeGreaterThan(0);
  await click(toggle);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Preserved through transition");
  await click(page.getByRole("button", { name: "Close AI chat", exact: true }));
  await expect.poll(() => dialog.hasAttribute("hidden")).toBe(true);
  await act(async () => userEvent.click(toggle));
  await expect.poll(() => dialog.getAnimations().length).toBeGreaterThan(0);
  await settleAIPosition();
  await click(page.getByRole("button", { name: "Close AI chat", exact: true }));
  await expect.poll(() => dialog.hasAttribute("hidden")).toBe(true);
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await click(toggle);
    expect(getComputedStyle(dialog).transitionProperty).toBe("none");
    expect(dialog.getAnimations()).toHaveLength(0);
    await click(page.getByRole("button", { name: "Close AI chat", exact: true }));
    await expect.poll(() => dialog.hasAttribute("hidden")).toBe(true);
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("moves the floating launcher with touch and distinguishes a drag from a tap", async () => {
  await page.viewport(390, 844);
  const session = cdp();
  const { result } = await session.send("Runtime.evaluate", {
    expression:
      'JSON.stringify(document.querySelector("iframe[data-vitest]")?.getBoundingClientRect().toJSON() ?? {x:0,y:0})',
    returnByValue: true,
  });
  const offset = JSON.parse(result.value as string) as { x: number; y: number };
  const toggle = page.getByRole("button", { name: "AI chat", exact: true });
  const before = toggle.element().getBoundingClientRect();
  const touch = (x: number, y: number) => ({ x: x + offset.x, y: y + offset.y, id: 1 });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  try {
    await act(async () => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touch(before.x + 28, before.y + 28)],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [touch(before.x - 100, before.y - 150)],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    const after = toggle.element().getBoundingClientRect();
    expect(after.x).toBeLessThan(before.x - 50);
    expect(after.y).toBeLessThan(before.y - 100);
    await expect.element(page.getByRole("dialog", { name: "AI chat", exact: true })).not.toBeInTheDocument();
    await act(async () => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touch(after.x + 28, after.y + 28)],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await expect.element(page.getByRole("region", { name: "AI conversation", exact: true })).toBeVisible();
    await settleAIPosition();
    const dialog = page.getByTestId("ai-floating-dialog").element();
    const chatBefore = dialog.getBoundingClientRect();
    await act(async () => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touch(after.x + 28, after.y + 28)],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [touch(after.x + 68, after.y + 128)],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await act(async () => {
      await expect.poll(() => dialog.getBoundingClientRect().bottom).toBeGreaterThan(chatBefore.bottom + 50);
    });
    expect(dialog.hasAttribute("data-open")).toBe(true);
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});

test.each([
  { width: 768, theme: "light", language: "en" },
  { width: 390, theme: "light", language: "en" },
  { width: 768, theme: "dark", language: "en" },
  { width: 390, theme: "dark", language: "en" },
  { width: 768, theme: "light", language: "zh-CN" },
  { width: 390, theme: "light", language: "zh-CN" },
  { width: 768, theme: "dark", language: "zh-CN" },
  { width: 390, theme: "dark", language: "zh-CN" },
] as const)(
  "provides reachable panels and touch controls without page overflow at $width in $theme/$language",
  async ({ width, theme, language }) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    await page.viewport(width, 900);
    const zh = language === "zh-CN";
    const labels = zh ? ["物体", "属性", "3D 视口"] : ["Objects", "Properties", "3D viewport"];
    const nav = page.getByRole("navigation", { name: zh ? "工作区面板" : "Workspace panels" });
    const initialCanvas = document.querySelector("canvas");
    const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    noOverflow();
    await expect.element(page.getByRole("region", { name: zh ? "3D 视口" : "3D viewport" })).toBeVisible();
    for (const panel of labels) {
      const button = nav.getByRole("button", { name: panel, exact: true });
      const box = button.element().getBoundingClientRect();
      expect(box.height).toBe(32);
      expect(box.width).toBeGreaterThanOrEqual(44);
      await click(button);
      if (panel === labels[0]) {
        await expect.element(page.getByRole("heading", { name: labels[0], exact: true })).toBeVisible();
        await addPrimitive();
        await expect.element(page.getByRole("button", { name: zh ? "立方体" : "Box", exact: true })).toBeVisible();
      }
      if (panel === labels[1])
        await expect.element(page.getByRole("textbox", { name: zh ? "物体名称" : "Object name" })).toBeVisible();
      noOverflow();
    }
    await expect.element(page.getByRole("region", { name: zh ? "3D 视口" : "3D viewport" })).toBeVisible();
    const canvasBounds = document.querySelector("canvas")!.getBoundingClientRect().toJSON();
    await click(page.getByRole("button", { name: zh ? "AI 对话" : "AI chat", exact: true }));
    await expect.element(page.getByRole("textbox", { name: zh ? "消息" : "Message" })).toBeVisible();
    expect(document.querySelector("canvas")!.getBoundingClientRect().toJSON()).toEqual(canvasBounds);
    noOverflow();
    await click(page.getByRole("button", { name: zh ? "关闭 AI 对话" : "Close AI chat", exact: true }));
    expect(document.querySelector("canvas")).toBe(initialCanvas);
  },
);