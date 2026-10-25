import { mockModelFetch } from "./helpers/model-fetch";
import { addPrimitive, click, fill, openAddObjectMenu, openAISettings, settleAIPosition } from "./helpers/workspace";
import { responsesFixture, anthropicFixture, geminiFixture } from "../../../tests/fixtures/ai/native-protocols";
import {
  chatTextResponse,
  chatToolCallResponse,
  controlledChatResponse,
} from "../../../tests/fixtures/ai/chat-completions";
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
import {
  AI_PROVIDER_SETTINGS_STORAGE_KEY,
  loadAIProviderSettings,
  saveAIProviderSettings,
  removeAIProviderCredential,
} from "@open-3d/ai/settings";
import { workspacePreferencesStorageKey } from "../src/workspace-preferences";
import { MODELING_COMMANDS, MODELING_QUERIES } from "@open-3d/model-core";
import type { LocalProjectStore, LocalProjectStorageErrorCode } from "@open-3d/projects";
import { createProcessor, emptyDocument } from "../src/workspace/modeling";
import { initializeWorkspacePreferences } from "../src/workspace-preferences";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import {
  IndexedDBModraRepository,
  ModraStorageError,
  MODRA_DATABASE_NAME,
} from "../src/modra/storage/indexeddb-repository";
import { drainModraClosures } from "../src/modra/controller/use-modra-controller";
import { WorkspaceApp } from "../src/app";
import { LocalProjectsDialog } from "../src/workspace/local-projects-dialog";
import { ThreeViewport } from "@open-3d/viewport-three";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { projects } from "../src/i18n/projects";
import { useWorkspaceUiStore } from "../src/workspace-ui-store";

let container: HTMLDivElement;
let root: Root;

test.each([390, 768, 1440])("keeps project menus and reference-header actions compact at %i", async (width) => {
  await page.viewport(width, 900);
  await addPrimitive();
  await click(page.getByRole("button", { name: "Save", exact: true }));
  await click(page.getByRole("button", { name: "Open projects", exact: true }));
  const manager = page.getByRole("dialog", { name: "Projects", exact: true });
  await click(manager.getByRole("button", { name: /^Manage / }));
  const menu = page.getByRole("menu");
  expect(menu.element().getBoundingClientRect().width).toBeLessThan(150);
  await expect.poll(() => getComputedStyle(menu.element()).opacity).toBe("1");
  await click(page.getByRole("menuitem", { name: "Delete", exact: true }));
  await expect.element(page.getByText(projects.en.deleteDescription, { exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Cancel", exact: true }));
  await click(page.getByRole("button", { name: "Close projects", exact: true }));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await expect.element(page.getByRole("button", { name: ai.en.attachSelection, exact: true })).not.toBeInTheDocument();
  await click(page.getByRole("button", { name: ai.en.mentionObject, exact: true }));
  const references = page.getByRole("dialog", { name: ai.en.mentionObject, exact: true });
  expect(references.element()).not.toHaveAttribute("aria-describedby");
  await expect
    .element(references.getByRole("textbox", { name: ai.en.searchObjects }))
    .toHaveAttribute("placeholder", ai.en.searchObjects);
  await expect.element(page.getByText(ai.en.referenceDescription, { exact: true })).not.toBeInTheDocument();
  const search = references.getByRole("textbox", { name: ai.en.searchObjects });
  for (const height of [900, 360]) {
    await page.viewport(width, height);
    await expect.poll(() => references.element().getBoundingClientRect().height).toBe(Math.min(400, height - 32));
    await fill(search, "no matching object");
    await expect.element(page.getByText(ai.en.noReferenceObjects, { exact: true })).toBeVisible();
    expect(references.element().getBoundingClientRect().height).toBe(Math.min(400, height - 32));
    await fill(search, "");
    expect(references.element().getBoundingClientRect().height).toBe(Math.min(400, height - 32));
    expect(references.element().scrollHeight).toBe(references.element().clientHeight);
  }
  const attach = references.getByRole("button", { name: ai.en.attachSelection, exact: true });
  const close = references.getByRole("button", { name: ai.en.closeReferences, exact: true });
  expect(
    Math.abs(attach.element().getBoundingClientRect().top - close.element().getBoundingClientRect().top),
  ).toBeLessThan(1);
  await click(attach);
  await expect.element(references).not.toBeInTheDocument();
  expect(document.querySelectorAll(".ai-prompt-form [data-object-reference]")).toHaveLength(1);
});

test.each(["en", "zh-CN"] as const)("uses one selection status for objects and components in %s", async (language) => {
  await act(async () => {
    await initializeI18n(language);
  });
  const status = document.querySelector(".context-copy")!;
  expect(status.textContent).toBe(language === "en" ? "Nothing selected" : "未选择物体或组件");
  await addPrimitive();
  const name = language === "en" ? "Box" : "立方体";
  const box = page.getByRole("button", { name, exact: true });
  await click(box);
  expect(status.textContent).toBe(name);
  await click(page.getByRole("button", { name: language === "en" ? "Face" : "面", exact: true }));
  expect(status.textContent).toBe(`${name} · ${language === "en" ? "Face" : "面"} × 6`);
});

vi.mock("@open-3d/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-3d/ai")>();
  return {
    ...actual,
    createModraProvider: (options: Parameters<typeof actual.createModraProvider>[0]) =>
      actual.createModraProvider({ ...options, retryTiming: { initialDelayMs: 0 } }),
  };
});

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
  for (const database of [LOCAL_PROJECTS_DATABASE_NAME, MODRA_DATABASE_NAME])
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(database);
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
  await drainModraClosures();
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
    await click(
      page.getByRole("button", { name: language === "en" ? "Actions for Box" : "立方体 的操作", exact: true }),
    );
    await click(page.getByRole("menuitem", { name: language === "en" ? "Delete Box" : "删除 立方体", exact: true }));
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
  expect(actions).toHaveLength(1);
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
test.for([390, 768, 1440])("aligns the icon-only stop control with request status at %i", async (width) => {
  await page.viewport(width, 900);
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const stream = controlledChatResponse("stop-layout");
  mockModelFetch().mockResolvedValueOnce(stream.response);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: ai.en.message }), "Build a lamp");
  await click(page.getByRole("button", { name: ai.en.send }));
  await act(async () => stream.text("I am checking the lamp proportions."));
  await expect.element(page.getByText("I am checking the lamp proportions.", { exact: true })).toBeVisible();
  const stop = page.getByRole("button", { name: ai.en.cancelRequest, exact: true });
  const node = stop.element();
  const bounds = node.getBoundingClientRect();
  const row = document.querySelector<HTMLElement>(".ai-request-status")!.getBoundingClientRect();
  const status = node.parentElement!.querySelector<HTMLElement>('[role="status"]')!.getBoundingClientRect();
  expect(node.textContent).toBe("");
  expect(node.querySelector(".lucide-square")).not.toBeNull();
  expect(bounds.width).toBe(24);
  expect(bounds.right).toBeCloseTo(row.right, 0);
  expect(bounds.y + bounds.height / 2).toBeCloseTo(status.y + status.height / 2, 0);
  await click(stop);
  await expect.element(page.getByText(ai.en.cancelled, { exact: true })).toBeVisible();
  await expect.element(stop).not.toBeInTheDocument();
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
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI service settings", exact: true });
    await expect.element(dialog).toBeVisible();
    expect(backdrop()).toHaveLength(1);
    expect(getComputedStyle(backdrop()[0]!).backgroundColor).toBe(expected);
    expect(Number(getComputedStyle(backdrop()[0]!).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(page.getByTestId("ai-floating-dialog").element()).zIndex),
    );
    const noticeToggle = dialog.getByRole("button", {
      name: ai[language].credentialSummary,
      exact: true,
    });
    await expect.element(noticeToggle).toHaveAttribute("aria-expanded", "false");
    const notice = document.getElementById("ai-credential-notice")!;
    expect(notice.checkVisibility()).toBe(false);
    await click(noticeToggle);
    await expect.poll(() => notice.checkVisibility()).toBe(true);
    expect(notice.textContent).toBe(ai[language].credentialNotice);
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
      dialog.getByRole("button", { name: zh ? "关闭 AI 服务设置" : "Close AI service settings", exact: true }),
    );
    await expect.poll(() => backdrop().length).toBe(0);
    await expect.element(page.getByRole("region", { name: zh ? "Modra" : "Modra", exact: true })).toBeVisible();
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
    await click(page.getByRole("button", { name: "Modra", exact: true }));
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
    const actions = page.getByRole("button", { name: "Actions for Box", exact: true });
    await act(async () => userEvent.hover(actions));
    await expectButtonSurface(actions, "soft");
    await click(actions);
    const hide = page.getByRole("menuitem", { name: "Hide Box", exact: true });
    await click(hide);
    await click(actions);
    await click(page.getByRole("menuitem", { name: "Show Box", exact: true }));
    await click(actions);
    const duplicate = page.getByRole("menuitem", { name: "Duplicate Box", exact: true });
    await act(async () => userEvent.hover(duplicate));
    await expectButtonSurface(duplicate, "soft");
    const remove = page.getByRole("menuitem", { name: "Delete Box", exact: true });
    await act(async () => userEvent.hover(remove));
    await expectButtonSurface(remove, "negative-soft");
    await act(async () => userEvent.keyboard("{Escape}"));
    for (const target of [
      page.getByRole("button", { name: "Save", exact: true }),
      page.getByRole("button", { name: "Open projects", exact: true }),
    ]) {
      await act(async () => userEvent.hover(target));
      await expectButtonSurface(target, "soft");
      expect(getComputedStyle(target.element()).color).not.toBe(semanticColor("primary-foreground"));
    }
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
  const launcher = page.getByRole("button", { name: "Modra", exact: true });
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
  await expect.element(page.getByRole("status")).toHaveTextContent("Box");
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
  await expect.element(toast).toHaveTextContent("Box");
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

  await click(page.getByRole("button", { name: "Actions for Desk block", exact: true }));
  await click(page.getByRole("menuitem", { name: "Duplicate Desk block", exact: true }));
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

test.each([
  { width: 1440, language: "en" },
  { width: 1000, language: "en" },
  { width: 768, language: "en" },
  { width: 390, language: "zh-CN" },
] as const)(
  "fits object rows and truncates long names without horizontal scrolling at $width/$language",
  async ({ width, language }) => {
    const zh = language === "zh-CN";
    await act(async () =>
      useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: zh ? "dark" : "light", language }),
    );
    await addPrimitive();
    await addPrimitive();
    const name = zh
      ? "用于建模的参考物体名称很长需要省略显示".repeat(6)
      : "VeryLongUnbrokenModelingReferenceObjectName".repeat(3);
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: zh ? "物体名称" : "Object name", exact: true }), name),
    );
    await act(async () => userEvent.keyboard("{Enter}"));
    await page.viewport(width, 844);
    if (width < 1000) {
      await click(
        page
          .getByRole("navigation", { name: zh ? "工作区面板" : "Workspace panels", exact: true })
          .getByRole("button", { name: zh ? "物体" : "Objects", exact: true }),
      );
    }
    const panel = page.getByTestId("left-panel");
    const select = panel.getByRole("button", { name, exact: true });
    await expect.element(select).toBeVisible();
    await expect.element(select).toHaveAttribute("title", name);
    await act(async () => userEvent.hover(select));
    const list = panel.element().querySelector<HTMLElement>(".object-list")!;
    const label = select.element().querySelector<HTMLElement>(".object-label")!;
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(list).overflowX).toBe("hidden");
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
    expect(panel.element().scrollWidth).toBeLessThanOrEqual(panel.element().clientWidth);
    for (const row of panel.getByTestId("object-row").elements()) {
      const bounds = row.getBoundingClientRect();
      expect(Math.abs(bounds.width - list.clientWidth)).toBeLessThanOrEqual(1);
      for (const action of row.querySelectorAll<HTMLElement>("button")) {
        expect(action.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
        expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      }
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const actions = panel.getByRole("button", { name: zh ? `${name} 的操作` : `Actions for ${name}`, exact: true });
    await click(actions);
    const menu = page.getByRole("menu");
    await expect.element(menu).toBeVisible();
    expect(menu.getByRole("menuitem").elements()).toHaveLength(3);
    const menuBounds = menu.element().getBoundingClientRect();
    expect(menuBounds.left).toBeGreaterThanOrEqual(0);
    expect(menuBounds.right).toBeLessThanOrEqual(width);
    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.element(actions).toHaveFocus();
  },
);

test("manages scene objects from the hierarchy", async () => {
  await addPrimitive();
  const actions = (name: string) => page.getByRole("button", { name: `Actions for ${name}`, exact: true });
  expect(page.getByTestId("object-row").element().querySelectorAll("button")).toHaveLength(2);
  await click(actions("Box"));
  await click(page.getByRole("menuitem", { name: "Hide Box" }));
  await click(actions("Box"));
  await expect.element(page.getByRole("menuitem", { name: "Show Box" })).toBeVisible();
  await click(page.getByRole("menuitem", { name: "Show Box" }));
  await click(actions("Box"));
  await expect.element(page.getByRole("menuitem", { name: "Hide Box" })).toBeVisible();
  await click(page.getByRole("menuitem", { name: "Duplicate Box" }));
  await expect.element(page.getByRole("button", { name: "Box copy", exact: true })).toBeInTheDocument();
  await click(actions("Box copy"));
  await click(page.getByRole("menuitem", { name: "Delete Box copy" }));
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
  await expect.element(page.getByRole("status")).toHaveTextContent("Box · Face × 1");
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
    // The dialog opens before its IndexedDB-backed project list has finished loading.
    await expect
      .poll(() =>
        dialog.element().querySelector<HTMLElement>('[data-project-id][aria-current="true"]')?.checkVisibility(),
      )
      .toBe(true);
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
      await expect
        .element(page.getByRole("dialog", { name: zh ? "删除项目？" : "Delete project?", exact: true }))
        .not.toBeInTheDocument();
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
      onNewProject: vi.fn(),
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
  expect(document.querySelector(".project-name")!.textContent).toContain("Untitled project");
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

test.each([
  { width: 1440, language: "en", theme: "light" },
  { width: 390, language: "zh-CN", theme: "dark" },
] as const)(
  "retains sealed project history after deletion failure and offers explicit cancellation at $width/$language",
  async ({ width, language, theme }) => {
    const zh = language === "zh-CN";
    await page.viewport(width, 900);
    const store = createLocalProjectStore();
    const saved = await store.save({ ...emptyDocument(), name: "Retained project" });
    const repo = new IndexedDBModraRepository({ notifications: false });
    try {
      const record = await repo.create(`project:${saved.id}`);
      const token = await repo.acquire(record.id, record.scopeId);
      await repo.saveDraft({ text: "History retained until explicit cancellation", assets: [] }, token);
      await repo.release(token);
      const remove = vi.spyOn(store, "remove").mockRejectedValueOnce(new LocalProjectStorageError("failed", "Denied"));
      const detach = vi.spyOn(WorkspaceModelingHost.prototype, "detachScope");
      await act(async () => {
        root.unmount();
        root = createRoot(container);
        useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language });
        root.render(<WorkspaceApp projectStore={store} modraRepository={repo} />);
      });
      await click(page.getByRole("button", { name: zh ? "打开项目" : "Open projects", exact: true }));
      const manager = page.getByRole("dialog", { name: zh ? "项目" : "Projects", exact: true });
      await click(manager.getByRole("button", { name: zh ? "打开" : "Open", exact: true }));
      await expect.poll(() => document.querySelector(".project-name")?.textContent).toContain("Retained project");
      await addPrimitive();
      await click(page.getByRole("button", { name: zh ? "打开项目" : "Open projects", exact: true }));
      await click(manager.getByRole("button", { name: /^(Manage |管理 )Retained project$/ }));
      await click(page.getByRole("menuitem", { name: zh ? "删除" : "Delete", exact: true }));
      const confirmation = page.getByRole("dialog", { name: zh ? "删除项目？" : "Delete project?", exact: true });
      await click(confirmation.getByRole("button", { name: zh ? "删除" : "Delete", exact: true }));
      await expect.element(confirmation.getByRole("alert")).toBeVisible();
      expect(remove).toHaveBeenCalledOnce();
      expect(detach).toHaveBeenCalledOnce();
      expect((await repo.load(record.id))?.draft.text).toBe("History retained until explicit cancellation");
      expect((await repo.projectDeletions())[0].phase).toBe("remove-failed");
      await click(confirmation.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
      const pending = manager.getByRole("region", { name: zh ? "待完成的项目删除" : "Pending project deletion" });
      await expect.element(pending).toBeVisible();
      await expect.element(manager.getByRole("button", { name: zh ? "打开" : "Open", exact: true })).toBeDisabled();
      const bounds = pending.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(16);
      expect(bounds.right).toBeLessThanOrEqual(width - 16);
      expect(pending.element().scrollWidth).toBeLessThanOrEqual(pending.element().clientWidth);
      await click(
        pending.getByRole("button", {
          name: zh ? "取消删除并解锁历史" : "Cancel deletion and unlock history",
          exact: true,
        }),
      );
      await expect.element(pending).not.toBeInTheDocument();
      await expect.element(manager.getByRole("button", { name: zh ? "打开" : "Open", exact: true })).toBeEnabled();
      expect(await repo.projectDeletions()).toEqual([]);
      expect((await repo.load(record.id))?.draft.text).toBe("History retained until explicit cancellation");
      await click(manager.getByRole("button", { name: zh ? "关闭项目" : "Close projects", exact: true }));
      if (width < 1000)
        await click(
          page
            .getByRole("navigation", { name: zh ? "工作区面板" : "Workspace panels" })
            .getByRole("button", { name: zh ? "物体" : "Objects", exact: true }),
        );
      await expect.element(page.getByRole("button", { name: zh ? "立方体" : "Box", exact: true })).toBeVisible();
    } finally {
      await repo.close();
    }
  },
);

test("shows retryable Modra cleanup after the project row has already been removed", async () => {
  const store = createLocalProjectStore();
  const saved = await store.save({ ...emptyDocument(), name: "Cleanup project" });
  const repo = new IndexedDBModraRepository({ notifications: false });
  try {
    const record = await repo.create(`project:${saved.id}`);
    const cleanup = vi.spyOn(repo, "completeProjectDeletion").mockRejectedValueOnce(new Error("Cleanup failed"));
    const remove = vi.spyOn(store, "remove");
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(<WorkspaceApp projectStore={store} modraRepository={repo} />);
    });
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    const manager = page.getByRole("dialog", { name: "Projects", exact: true });
    await click(manager.getByRole("button", { name: "Manage Cleanup project", exact: true }));
    await click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    const confirmation = page.getByRole("dialog", { name: "Delete project?", exact: true });
    await click(confirmation.getByRole("button", { name: "Delete", exact: true }));
    await expect.element(confirmation.getByRole("alert")).toBeVisible();
    expect(await store.list()).toEqual([]);
    expect((await repo.projectDeletions())[0].phase).toBe("removed");
    await click(confirmation.getByRole("button", { name: "Cancel", exact: true }));
    await click(manager.getByRole("button", { name: "Close projects", exact: true }));
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    const pending = manager.getByRole("region", { name: "Pending project deletion", exact: true });
    await expect
      .element(
        pending.getByText(
          "The project was removed, but its Modra data is still locked. Try again to finish cleaning up local data.",
          {
            exact: true,
          },
        ),
      )
      .toBeVisible();
    await expect
      .element(pending.getByRole("button", { name: "Cancel deletion and unlock history", exact: true }))
      .not.toBeInTheDocument();
    await click(pending.getByRole("button", { name: "Retry deletion", exact: true }));
    await expect.element(pending).not.toBeInTheDocument();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
    expect(await repo.load(record.id)).toBeNull();
  } finally {
    await repo.close();
  }
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
  await expect.element(page.getByRole("status")).toHaveTextContent("Box");

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
    .element(page.getByRole("dialog", { name: "Projects" }).getByText("Untitled project", { exact: true }))
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
    expectedError: "missing modelingDocument data",
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
  await click(page.getByRole("button", { name: "Dismiss file error" }));
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
  await click(dialog.getByRole("button", { name: "Dismiss file error" }));
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
  await expect.element(page.getByRole("status")).toHaveTextContent("Interchange scene imported. Omitted cameras: 1.");
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
    .toHaveTextContent("Untitled project imported. Save it to this browser or export a portable copy.");
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
    .element(menu.getByText("Export as open3d for a portable, editable project", { exact: false }))
    .toBeInTheDocument();
  await expect
    .element(menu.getByText("without editor state or unsupported extensions", { exact: false }))
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
    const element = dialog.element().querySelector<HTMLElement>(".ai-settings-dialog") ?? dialog.element();
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
    .element(remove.getByText(projects[language as keyof typeof projects].deleteDescription, { exact: true }))
    .toBeVisible();
  await click(page.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
  await click(page.getByRole("button", { name: zh ? "关闭项目" : "Close projects", exact: true }));
  await openAISettings();
  const settings = await expectChrome(zh ? "AI 服务设置" : "AI service settings");
  await expect.element(settings.getByText(ai[language].credentialSummary, { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: zh ? "关闭 AI 服务设置" : "Close AI service settings", exact: true }));
  await click(page.getByRole("button", { name: zh ? "关闭 Modra" : "Close Modra", exact: true }));
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
    const launcher = page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true });
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
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI service settings", exact: true });
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
    await expect.element(page.getByRole("region", { name: zh ? "Modra" : "Modra", exact: true })).toBeVisible();
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
      route: "direct",
    });
    expect(dialog.element().querySelector('[role="status"]')).toBeNull();
  },
);

test("validates provider settings by field and saves usable configuration locally", async () => {
  await openAISettings();
  const dialog = page.getByRole("dialog", { name: "AI service settings" });
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
    route: "direct",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  await openAISettings();
  await click(dialog.getByRole("button", { name: ai.en.credentialSummary, exact: true }));
  await expect.element(dialog.getByText(ai.en.credentialNotice, { exact: true })).toBeVisible();
});

test.each(["en", "zh-CN"] as const)(
  "keeps failed AI settings saves open and closes after retry in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    const zh = language === "zh-CN";
    const original = {
      protocol: "openai-compatible" as const,
      route: "direct" as const,
      baseURL: "https://old.example.test/v1",
      modelId: "old-model",
    };
    saveAIProviderSettings(original);
    await openAISettings();
    const dialog = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI service settings", exact: true });
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
    await expect.element(page.getByRole("region", { name: zh ? "Modra" : "Modra", exact: true })).toBeVisible();
  },
);

test("directs unconfigured AI prompts to provider settings without sending a request", async () => {
  const fetchMock = mockModelFetch();
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  expect(document.querySelector(".ai-endpoint-disclosure")).toBeNull();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a cube"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect.element(page.getByRole("dialog", { name: "AI service settings" })).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(["en", "zh-CN"] as const)("selects approval modes with compact controls in %s", async (language) => {
  await act(async () =>
    useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: language === "en" ? "light" : "dark", language }),
  );
  await page.viewport(390, 844);
  const zh = language === "zh-CN";
  await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
  const mode = page.getByRole("button", { name: zh ? "批准模式" : "Approval mode", exact: true });
  await expect.element(mode).toHaveTextContent(zh ? "请求批准" : "Request approval");
  await click(mode);
  await click(page.getByRole("menuitemradio", { name: zh ? "自动批准" : "Auto-approve", exact: true }));
  await expect.element(mode).toHaveTextContent(zh ? "自动批准" : "Auto-approve");
  await click(mode);
  await click(page.getByRole("menuitemradio", { name: zh ? "请求批准" : "Request approval", exact: true }));
  await expect.element(mode).toHaveTextContent(zh ? "请求批准" : "Request approval");
  const dialog = page.getByTestId("ai-floating-dialog").element().getBoundingClientRect();
  for (const control of [mode, page.getByRole("button", { name: zh ? "添加图片" : "Add images", exact: true })]) {
    const rect = control.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(dialog.left);
    expect(rect.right).toBeLessThanOrEqual(dialog.right);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

test("automatically approves consecutive modeling batches and preserves undo history", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("top", "command_scene_createPrimitive", { primitive: "box", name: "Table top" }),
    )
    .mockResolvedValueOnce(chatTextResponse("top-summary", "The tabletop is ready."))
    .mockResolvedValueOnce(
      chatToolCallResponse("leg", "command_scene_createPrimitive", { primitive: "cylinder", name: "Table leg" }),
    )
    .mockResolvedValueOnce(chatTextResponse("leg-summary", "The table leg is ready."))
    .mockResolvedValueOnce(chatTextResponse("complete", "The table is complete."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await click(page.getByRole("button", { name: "Approval mode", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a table"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("The table is complete.", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Table leg", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText(/Applied as one undoable action/)).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(5);
  await click(page.getByRole("button", { name: "Undo", exact: true }));
  await expect.element(page.getByRole("button", { name: "Table leg", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Undo", exact: true }));
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
});

test("retains a failed automatic batch for manual review without applying it", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("failed-batch", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Unconfirmed box",
      }),
    )
    .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await click(page.getByRole("button", { name: "Approval mode", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  expect(document.querySelectorAll(".ai-message")).toHaveLength(2);
  await expect.element(page.getByText("AI preview · not applied")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Keep changes", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Discard changes", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test.each([
  { language: "en", mode: "request", action: "keep", failure: "network" },
  { language: "zh-CN", mode: "request", action: "discard", failure: "network" },
  { language: "en", mode: "auto", action: "discard", failure: "tool" },
  { language: "zh-CN", mode: "auto", action: "keep", failure: "tool" },
] as const)(
  "$action partial changes after $failure failure in $mode mode/$language",
  async ({ language, mode, action, failure }) => {
    const zh = language === "zh-CN";
    await act(async () =>
      useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: zh ? "dark" : "light", language }),
    );
    await page.viewport(390, 844);
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    const setDocument = vi.spyOn(ThreeViewport.prototype, "setDocument");
    const fetchMock = mockModelFetch().mockResolvedValueOnce(
      chatToolCallResponse("valid-part", "command_scene_createPrimitive", { primitive: "box", name: "Partial box" }),
    );
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    else
      fetchMock.mockResolvedValue(
        chatToolCallResponse("invalid-part", "command_scene_createPrimitive", { primitive: "torus" }),
      );
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    if (mode === "auto") {
      await click(page.getByRole("button", { name: zh ? "批准模式" : "Approval mode", exact: true }));
      await click(page.getByRole("menuitemradio", { name: zh ? "自动批准" : "Auto-approve", exact: true }));
    }
    await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), referenceImage("reference.png")));
    await expect
      .element(page.getByRole("button", { name: zh ? "移除 reference.png" : "Remove reference.png" }))
      .toBeVisible();
    await act(async () =>
      userEvent.fill(
        page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true }),
        "Build a box and a sphere",
      ),
    );
    const send = page.getByRole("button", { name: zh ? "发送提示词" : "Send prompt", exact: true });
    await click(send);
    await expect.element(page.getByText(zh ? "请求失败" : "Request failed", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: zh ? "保留更改" : "Keep changes", exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll("[data-ai-proposals] li")).toHaveLength(1);
    expect(document.querySelector("[data-ai-proposals]")?.textContent).toContain("Partial box");
    expect(document.querySelectorAll(".ai-message")).toHaveLength(2);
    expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
    await expect.element(page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true })).toHaveValue("");
    expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(0);
    expect(document.querySelectorAll(".ai-message img")).toHaveLength(1);
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    expect(setDocument.mock.calls.at(-1)?.[0].objects.map((object) => object.name)).toEqual(["Partial box"]);
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true }), "Continue modeling"),
    );
    await expect
      .element(page.getByRole("button", { name: zh ? "加入待发送" : "Add to queue", exact: true }))
      .toBeEnabled();
    const callsBeforeDecision = fetchMock.mock.calls.length;
    const keep = action === "keep";
    await click(
      page.getByRole("button", {
        name: keep ? (zh ? "保留更改" : "Keep changes") : zh ? "丢弃更改" : "Discard changes",
        exact: true,
      }),
    );
    await expect
      .element(page.getByRole("button", { name: zh ? "保留更改" : "Keep changes", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(send).toBeEnabled();
    expect(document.querySelectorAll("[data-ai-proposals] li")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeDecision);
    const undo = page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true });
    if (keep) {
      expect(document.querySelectorAll(".object-row")).toHaveLength(1);
      expect(document.querySelector(".object-row")?.textContent).toContain("Partial box");
      await expect.element(undo).toBeEnabled();
      await click(page.getByRole("button", { name: zh ? "关闭 Modra" : "Close Modra", exact: true }));
      await click(undo);
    } else {
      await expect.element(undo).toBeDisabled();
    }
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    expect(setDocument.mock.calls.at(-1)?.[0].objects).toHaveLength(0);
  },
);

test.each(["keep", "discard"] as const)(
  "%s a failed continuation without losing earlier automatic batches",
  async (action) => {
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    const fetchMock = mockModelFetch()
      .mockResolvedValueOnce(
        chatToolCallResponse("first-batch", "command_scene_createPrimitive", { primitive: "box", name: "Applied box" }),
      )
      .mockResolvedValueOnce(chatTextResponse("first-summary", "The first box is ready."))
      .mockResolvedValueOnce(
        chatToolCallResponse("second-batch", "command_scene_createPrimitive", {
          primitive: "uv-sphere",
          name: "Partial sphere",
        }),
      )
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await click(page.getByRole("button", { name: "Approval mode", exact: true }));
    await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
    await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build a box and a sphere"));
    await click(page.getByRole("button", { name: "Send prompt", exact: true }));
    await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
    expect(document.querySelectorAll(".object-row")).toHaveLength(1);
    await expect.element(page.getByText("AI preview · not applied")).toBeVisible();
    await click(
      page.getByRole("button", { name: action === "keep" ? "Keep changes" : "Discard changes", exact: true }),
    );
    await expect.element(page.getByText("AI preview · not applied")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Applied box", exact: true })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    if (action === "keep") {
      await expect.element(page.getByRole("button", { name: "Partial sphere", exact: true })).toBeVisible();
      await click(page.getByRole("button", { name: "Undo", exact: true }));
      await expect.element(page.getByRole("button", { name: "Partial sphere", exact: true })).not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Applied box", exact: true })).toBeVisible();
    }
    await click(page.getByRole("button", { name: "Undo", exact: true }));
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  },
);

test.each(["request", "auto"] as const)(
  "does not restore text or images when a %s continuation fails before producing output",
  async (mode) => {
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    const fetchMock = mockModelFetch()
      .mockResolvedValueOnce(chatToolCallResponse("box", "command_scene_createPrimitive", { primitive: "box" }))
      .mockResolvedValueOnce(chatTextResponse("summary", ""))
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    if (mode === "auto") {
      await click(page.getByRole("button", { name: "Approval mode", exact: true }));
      await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
    }
    await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), referenceImage("reference.png")));
    await expect.element(page.getByRole("button", { name: "Remove reference.png", exact: true })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await act(async () => userEvent.fill(composer, "Build from this image"));
    await click(page.getByRole("button", { name: "Send prompt", exact: true }));
    if (mode === "request") {
      await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).toBeVisible();
      await act(async () => userEvent.fill(composer, "Next draft"));
      await click(page.getByRole("button", { name: "Accept changes", exact: true }));
    }
    await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
    await expect.element(composer).toHaveValue(mode === "request" ? "Next draft" : "");
    expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(0);
    expect(document.querySelectorAll(".ai-message img")).toHaveLength(1);
    expect(document.querySelectorAll(".object-row")).toHaveLength(1);
    expect(document.querySelectorAll(".ai-message")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  },
);

test("pauses automatic approval after 20 batches without requesting a 21st", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch();
  for (let index = 0; index < 21; index++) {
    fetchMock.mockResolvedValueOnce(
      chatToolCallResponse(`batch-${index}`, "command_scene_createPrimitive", {
        primitive: "box",
        name: `Box ${index}`,
      }),
    );
    fetchMock.mockResolvedValueOnce(chatTextResponse(`summary-${index}`, `Batch ${index} ready.`));
  }
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await click(page.getByRole("button", { name: "Approval mode", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build many boxes"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Automatic approval paused after 20 batches. Review the scene before continuing.");
  expect(fetchMock).toHaveBeenCalledTimes(40);
  expect(document.querySelectorAll(".object-row")).toHaveLength(20);
  await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).not.toBeInTheDocument();
});

test("cancels an automatic continuation without undoing applied batches or applying incomplete ones", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let resolveContinuation!: (response: Response) => void;
  const continuation = new Promise<Response>((resolve) => {
    resolveContinuation = resolve;
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("first", "command_scene_createPrimitive", { primitive: "box", name: "Approved box" }),
    )
    .mockResolvedValueOnce(chatTextResponse("first-summary", "First batch ready."))
    .mockReturnValueOnce(continuation);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await click(page.getByRole("button", { name: "Approval mode", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Build two boxes"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.poll(() => fetchMock.mock.calls.length).toBe(3);
  await expect.element(page.getByRole("button", { name: "Approved box", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Approval mode", exact: true })).toBeEnabled();
  await click(page.getByRole("button", { name: "Cancel request", exact: true }));
  await act(async () => resolveContinuation(chatTextResponse("late", "Late response")));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
  await expect.element(page.getByText("Late response", { exact: true })).not.toBeInTheDocument();
  await click(page.getByRole("button", { name: "Undo", exact: true }));
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
});

function referenceImage(name: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ededed";
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = "#454545";
  if (name === "side.png") {
    context.fillRect(22, 12, 20, 40);
  } else {
    context.fillRect(12, 12, 40, 40);
  }
  const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (value) => value.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

test("previews and removes multiple images, sends them to the provider and retains image history", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(chatTextResponse("images", "I see two views."))
    .mockResolvedValueOnce(chatTextResponse("followup", "I will use those views."));
  await page.viewport(390, 844);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  const files = [referenceImage("front.png"), referenceImage("side.png"), referenceImage("remove.png")];
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), files));
  await expect.element(page.getByRole("button", { name: "Remove remove.png", exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Remove remove.png", exact: true }));
  expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(2);
  await fill(page.getByRole("textbox", { name: "Message" }), "Model these views");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("I see two views.", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(0);
  expect(document.querySelectorAll(".ai-message img")).toHaveLength(2);
  const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).messages.find(
    (message: { role: string }) => message.role === "user",
  );
  expect(sent.content[0]).toEqual({ type: "text", text: "Model these views" });
  expect(sent.content).toHaveLength(3);
  expect(sent.content.slice(1)).toEqual([
    { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
  ]);
  await fill(page.getByRole("textbox", { name: "Message" }), "Continue");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("I will use those views.", { exact: true })).toBeVisible();
  expect(
    JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).messages.find(
      (message: { role: string }) => message.role === "user",
    ),
  ).toEqual(sent);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

test("restores image-only prompts after failure and resends their attachments", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    .mockResolvedValueOnce(chatTextResponse("retry-images", "I can model this image."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), referenceImage("reference.png")));
  await expect.element(page.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Remove reference.png", exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message")).toHaveLength(1);
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("I can model this image.", { exact: true })).toBeVisible();
  const body = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
  const userMessages = body.messages.filter((message: { role: string }) => message.role === "user");
  expect(userMessages[0].content).toEqual(userMessages[1].content);
  expect(userMessages[1].content[0].type).toBe("image_url");
});

test("rejects too many, oversized and invalid image files without sending a request", async () => {
  const fetchMock = mockModelFetch();
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  const input = page.getByTestId("ai-image-input");
  await act(async () =>
    userEvent.upload(
      input,
      Array.from({ length: 6 }, (_, index) => referenceImage(`${index}.png`)),
    ),
  );
  await expect.element(page.getByRole("alert")).toHaveTextContent("Attach up to 5 images per message.");
  await act(async () =>
    userEvent.upload(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Each image must be non-empty and no larger than 5 MB.");
  await act(async () => userEvent.upload(input, new File(["not an image"], "broken.png", { type: "image/png" })));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not read an image. Choose a valid image and try again.");
  await expect.element(page.getByRole("button", { name: "Add images", exact: true })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Send prompt", exact: true })).toBeDisabled();
  expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("cancels an in-flight request without applying unconfirmed edits", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch().mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Add a box");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await click(page.getByRole("button", { name: "Cancel request" }));

  await expect
    .element(page.getByRole("region", { name: "Modra", exact: true }).getByRole("status").last())
    .toHaveTextContent("Request cancelled");
  expect(document.querySelectorAll(".ai-message")).toHaveLength(1);
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
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    .mockResolvedValueOnce(chatTextResponse("continue", "Continuing the table."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Build a table");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Cancel request" }));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  await expect.element(page.getByText(partial, { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  await fill(page.getByRole("textbox", { name: "Message" }), "Continue");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Continuing the table.", { exact: true })).toBeVisible();
  const continuedMessages = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).messages;
  expect(continuedMessages[0]).toEqual({ role: "system", content: expect.stringContaining("fresh bounded hierarchy") });
  expect(continuedMessages.slice(1)).toEqual([
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
  const fetchMock = mockModelFetch();
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
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  expect(document.querySelector(".ai-endpoint-disclosure")).toBeNull();
  await fill(page.getByRole("textbox", { name: "Message" }), "Build a table");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeInTheDocument();
  const lists = document.querySelectorAll<HTMLElement>("[data-ai-proposals]");
  expect(document.querySelectorAll("[data-ai-proposals] li")).toHaveLength(8);
  // Commands now stay in response order, rather than a separately scrolling aggregate.
  expect(lists).toHaveLength(8);
  for (const list of lists) expect(list.scrollHeight).toBe(list.clientHeight);
  const parts = document.querySelectorAll<HTMLElement>("[data-message-part]");
  expect(parts[parts.length - 1]?.dataset.messagePart).toBe("text");
  expect(parts[parts.length - 1]?.textContent).toBe("All components are ready.");
  const transcript = document.querySelector<HTMLElement>(".ai-transcript")!;
  expect(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop).toBeLessThanOrEqual(1);
});

test("previews a multi-step AI model operation on the canvas until accepted", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("create-table", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Table top",
      }),
    )
    .mockResolvedValueOnce(chatTextResponse("table-summary", "The table is ready for review."))
    .mockResolvedValueOnce(chatTextResponse("table-complete", "The table task is complete."));

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Build a table.");
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect.element(page.getByText("The table is ready for review.")).toBeInTheDocument();
  await expect.element(page.getByText("AI preview · not applied")).toBeInTheDocument();
  await expect.element(page.getByText(/Previewing 1 proposed change on the canvas/)).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await click(page.getByRole("button", { name: "Accept changes" }));
  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();
  await expect.element(page.getByText("AI preview · not applied")).not.toBeInTheDocument();
  await expect.element(page.getByText("Applied as one undoable action. Use Undo to revert.")).not.toBeInTheDocument();
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
  const fetchMock = mockModelFetch()
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

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Build a table.");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await click(page.getByRole("button", { name: "Accept changes" }));

  await expect.element(page.getByRole("button", { name: "Table top", exact: true })).toBeInTheDocument();
  const nextProposal = page.getByRole("region", { name: "Proposed modeling changes" }).last();
  await expect
    .element(nextProposal.getByText("Previewing 1 proposed change on the canvas", { exact: true }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Table leg", exact: true })).not.toBeInTheDocument();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(4);
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
  mockModelFetch()
    .mockResolvedValueOnce(chatToolCallResponse("create-box", "command_scene_createPrimitive", { primitive: "box" }))
    .mockResolvedValueOnce(chatTextResponse("box-summary", "A box is ready for review."));

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Add a box.");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("AI preview · not applied")).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Reject" }));

  await expect.element(page.getByText("AI preview · not applied")).not.toBeInTheDocument();
  expect(document.querySelector(".viewport-empty")).toBeNull();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  await expect.element(page.getByText("Proposal rejected. This batch was not applied.")).toBeInTheDocument();
});

test.each(["en", "zh-CN"] as const)(
  "shows connection retry progress and recovers without duplicating messages in %s",
  async (language) => {
    const zh = language === "zh-CN";
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ language, theme: "light" }));
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    let resolveRetry!: (response: Response) => void;
    const retry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchMock = mockModelFetch()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(retry);
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    await fill(page.getByRole("textbox", { name: zh ? "消息" : "Message" }), "Make a chair");
    await click(page.getByRole("button", { name: zh ? "发送提示词" : "Send prompt" }));
    await expect
      .element(page.getByText(zh ? "连接中断，正在重连 1/5…" : "Connection lost. Reconnecting 1/5…", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: zh ? "取消请求" : "Cancel request", exact: true }))
      .toBeEnabled();
    expect(document.querySelectorAll(".ai-message")).toHaveLength(2);
    await act(async () => resolveRetry(chatTextResponse("recovered", "Connected again")));
    await expect.element(page.getByText("Connected again", { exact: true })).toBeVisible();
    await expect.element(page.getByText(zh ? "响应完成" : "Response complete", { exact: true })).toBeVisible();
    expect(document.querySelectorAll(".ai-message")).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(
      JSON.parse(fetchMock.mock.calls[1]![1]!.body as string),
    );
  },
);

test("stops after five connection retries and restores an unanswered prompt with its images", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch().mockRejectedValue(new TypeError("Failed to fetch"));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), referenceImage("reference.png")));
  await expect.element(page.getByRole("button", { name: "Remove reference.png", exact: true })).toBeVisible();
  await fill(page.getByRole("textbox", { name: "Message" }), "Model this view");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(document.querySelectorAll(".ai-message")).toHaveLength(1);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Model this view");
  expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(1);
});

test("cancels automatic reconnecting without starting another retry or leaving a loading reply", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let resolveRetry!: (response: Response) => void;
  const retry = new Promise<Response>((resolve) => {
    resolveRetry = resolve;
  });
  const fetchMock = mockModelFetch().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockReturnValueOnce(retry);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Make a chair");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Connection lost. Reconnecting 1/5…", { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Cancel request", exact: true }));
  await act(async () => resolveRetry(chatTextResponse("late", "Ignore this response")));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Ignore this response", { exact: true })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
});

test.each([
  { width: 1440, language: "en" },
  { width: 390, language: "zh-CN" },
] as const)(
  "shows expandable command and query call details at $width/$language without applying previews",
  async ({ width, language }) => {
    const zh = language === "zh-CN";
    await act(async () =>
      useWorkspaceUiStore.getState().updateDisplayPreferences({ language, theme: zh ? "dark" : "light" }),
    );
    await page.viewport(width, 844);
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    mockModelFetch()
      .mockResolvedValueOnce(
        chatToolCallResponse("box", "command_scene_createPrimitive", { primitive: "box", name: "Tool preview box" }),
      )
      .mockResolvedValueOnce(chatToolCallResponse("inspect", "query_scene_getHierarchy", { limit: 20 }))
      .mockResolvedValueOnce(chatTextResponse("summary", "Ready for review"));
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: zh ? "消息" : "Message" }), "Create and inspect a box"),
    );
    await click(page.getByRole("button", { name: zh ? "发送提示词" : "Send prompt" }));
    await expect.element(page.getByText("Ready for review", { exact: true })).toBeVisible();
    const tools = page.getByRole("region", { name: zh ? "工具调用" : "Tool calls", exact: true });
    expect(document.querySelectorAll("[data-ai-tool-call]")).toHaveLength(2);
    expect(document.querySelectorAll('[data-tool-status="completed"]')).toHaveLength(2);
    await click(tools.getByText("query_scene_getHierarchy", { exact: true }));
    await expect.element(tools.getByText(zh ? "参数" : "Parameters", { exact: true }).last()).toBeVisible();
    await expect.element(tools.getByText(zh ? "结果" : "Result", { exact: true }).last()).toBeVisible();
    expect(document.querySelector("[data-ai-tool-call]:last-child details[open]")?.textContent).toContain(
      "Tool preview box",
    );
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    await expect
      .element(page.getByRole("button", { name: zh ? "接受更改" : "Accept changes", exact: true }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const transcript = document.querySelector(".ai-transcript")!;
    expect(transcript.scrollWidth).toBeLessThanOrEqual(transcript.clientWidth + 1);
  },
);

test.each(["cancel", "disconnect"] as const)(
  "marks an unfinished tool call after %s without retrying the consumed stream",
  async (action) => {
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const fetchMock = mockModelFetch().mockResolvedValueOnce(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await fill(page.getByRole("textbox", { name: "Message" }), "Create a box");
    await click(page.getByRole("button", { name: "Send prompt" }));
    await act(async () =>
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            id: "partial-tool",
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
                      id: "partial-tool",
                      type: "function",
                      function: { name: "command_scene_createPrimitive", arguments: '{"primitive":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      ),
    );
    await expect
      .poll(() => document.querySelector("[data-ai-tool-call]")?.getAttribute("data-tool-status"))
      .toBe("preparing");
    if (action === "cancel") await click(page.getByRole("button", { name: "Cancel request", exact: true }));
    else await act(async () => controller.error(new TypeError("Failed to fetch")));
    await expect
      .element(page.getByText(action === "cancel" ? "Request cancelled" : "Request failed", { exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-ai-tool-call]")?.getAttribute("data-tool-status")).toBe(
      action === "cancel" ? "cancelled" : "failed",
    );
    expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  },
);

test("keeps failed tool details visible with no loading indicator", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const fetchMock = mockModelFetch().mockResolvedValueOnce(
    chatToolCallResponse("invalid", "command_scene_createPrimitive", { primitive: "torus" }),
  );
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Create a torus");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
  expect(document.querySelectorAll('[data-tool-status="failed"]')).toHaveLength(1);
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
  await click(page.getByText("command_scene_createPrimitive", { exact: true }));
  await expect
    .element(page.getByText("The tool call failed. Check the request error before continuing."))
    .toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("recovers from provider authentication errors and keeps the prompt available to resend", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: "invalid-key",
  });
  const fetchMock = mockModelFetch()
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

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Add a box");
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect
    .element(page.getByRole("alert").getByText("The provider rejected the request. Check the endpoint and API key."))
    .toBeInTheDocument();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Add a box");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Recovered", { exact: true })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("removes empty failed assistant replies and only loads the active reply on retry", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let resolveRetry!: (response: Response) => void;
  const retry = new Promise<Response>((resolve) => {
    resolveRetry = resolve;
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
    .mockReturnValueOnce(retry);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Add a box");
  for (let attempt = 0; attempt < 2; attempt++) {
    await click(page.getByRole("button", { name: "Send prompt" }));
    await expect.poll(() => fetchMock.mock.calls.length).toBe(attempt + 1);
    await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Send prompt" })).toBeEnabled();
    expect(document.querySelectorAll(".ai-message")).toHaveLength(attempt + 1);
    expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
  }
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message")).toHaveLength(4);
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(1);
  expect(document.querySelector(".ai-message:last-child .animate-spin")).not.toBeNull();
  await act(async () => resolveRetry(chatTextResponse("retry", "Recovered")));
  await expect.element(page.getByText("Recovered", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Response complete", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
});

test.each(
  (["request", "auto"] as const).flatMap((mode) => [
    { mode, label: "partial", text: "I started building the table." },
    { mode, label: "whitespace-only", text: "  \n " },
  ]),
)("handles a failed $label reply in $mode mode without reviving it on retry", async ({ text, mode }) => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  let resolveRetry!: (response: Response) => void;
  const retry = new Promise<Response>((resolve) => {
    resolveRetry = resolve;
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    .mockReturnValueOnce(retry);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  if (mode === "auto") {
    await click(page.getByRole("button", { name: "Approval mode", exact: true }));
    await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  }
  await act(async () =>
    userEvent.upload(page.getByTestId("ai-image-input"), [referenceImage("front.png"), referenceImage("side.png")]),
  );
  await expect.element(page.getByRole("button", { name: "Remove side.png", exact: true })).toBeVisible();
  await fill(page.getByRole("textbox", { name: "Message" }), "Build a table");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await act(async () => {
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          id: "partial-error",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
      ),
    );
  });
  await expect.poll(() => document.querySelector(".ai-message:last-child p")?.textContent).toBe(text);
  await act(async () => controller.error(new TypeError("Failed to fetch")));
  await expect.element(page.getByText("Request failed", { exact: true })).toBeVisible();
  const retainedMessages = text.trim() ? 2 : 1;
  expect(document.querySelectorAll(".ai-message")).toHaveLength(retainedMessages);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue(text.trim() ? "" : "Build a table");
  expect(document.querySelectorAll(".ai-prompt-form img")).toHaveLength(text.trim() ? 0 : 2);
  expect(document.querySelectorAll(".ai-message img")).toHaveLength(2);
  if (text.trim()) {
    await expect.element(page.getByRole("button", { name: "Send prompt" })).toBeDisabled();
    await fill(page.getByRole("textbox", { name: "Message" }), "Continue the table");
  }
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message")).toHaveLength(retainedMessages + 2);
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(1);
  expect(document.querySelector(".ai-message:last-child .animate-spin")).not.toBeNull();
  if (text.trim()) await expect.element(page.getByText(text, { exact: true })).toBeVisible();
  await expect.poll(() => fetchMock.mock.calls.length).toBe(2);
  const history = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).messages;
  const original = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).messages.find(
    (message: { role: string }) => message.role === "user",
  );
  expect(history.find((message: { role: string }) => message.role === "user")).toEqual(original);
  expect(history.at(-1).content).toEqual(text.trim() ? "Continue the table" : original.content);
  expect(history.filter((message: { role: string }) => message.role === "assistant")).toEqual(
    text.trim() ? [{ role: "assistant", content: text }] : [],
  );
  await act(async () => resolveRetry(chatTextResponse("retry", "The table is ready.")));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
});

test("a late cancelled-request failure never replaces a newer text and image draft", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const stream = controlledChatResponse("cancelled-draft");
  let rejectLate!: (error: Error) => void;
  const pending = new Promise<Response>((_, reject) => {
    rejectLate = reject;
  });
  const fetchMock = mockModelFetch()
    .mockResolvedValueOnce(stream.response)
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(chatTextResponse("new-draft", "Using your new draft."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await fill(composer, "Original task");
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await act(async () => stream.text("Original partial response"));
  await expect.element(page.getByText("Original partial response", { exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Cancel request", exact: true }));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  await fill(composer, "Cancelled again");
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await click(page.getByRole("button", { name: "Cancel request", exact: true }));
  await expect.element(page.getByText("Request cancelled", { exact: true })).toBeVisible();
  await fill(composer, "New draft");
  await act(async () => userEvent.upload(page.getByTestId("ai-image-input"), referenceImage("new-draft.png")));
  await expect.element(page.getByRole("button", { name: "Remove new-draft.png", exact: true })).toBeVisible();
  await act(async () => rejectLate(new TypeError("Late transport error")));
  await expect.element(composer).toHaveValue("New draft");
  await expect.element(page.getByRole("button", { name: "Remove new-draft.png", exact: true })).toBeVisible();
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(0);
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await expect.element(page.getByText("Using your new draft.", { exact: true })).toBeVisible();
  expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string).messages.at(-1).content).toEqual([
    { type: "text", text: "New draft" },
    { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
  ]);
});

test("does not show loading on a completed textless proposal during a new request", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let resolveNext!: (response: Response) => void;
  const next = new Promise<Response>((resolve) => {
    resolveNext = resolve;
  });
  mockModelFetch()
    .mockResolvedValueOnce(chatToolCallResponse("box", "command_scene_createPrimitive", { primitive: "box" }))
    .mockResolvedValueOnce(chatTextResponse("summary", ""))
    .mockReturnValueOnce(next);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Add a box");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).toBeVisible();
  await expect.element(page.getByText("Response complete", { exact: true })).toBeVisible();
  const proposalMessage = document.querySelector(".ai-message:last-child")!;
  expect(proposalMessage.querySelector('[data-message-part="text"]')).toBeNull();
  expect(proposalMessage.querySelector(".animate-spin")).toBeNull();
  // Resolve review before starting an independent request; unresolved work queues follow-ups.
  await click(page.getByRole("button", { name: "Reject", exact: true }));
  await fill(page.getByRole("textbox", { name: "Message" }), "Explain the box");
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  expect(proposalMessage.querySelector(".animate-spin")).toBeNull();
  expect(document.querySelectorAll(".ai-message .animate-spin")).toHaveLength(1);
  expect(document.querySelector(".ai-message:last-child .animate-spin")).not.toBeNull();
  await act(async () => resolveNext(chatTextResponse("explain", "This is a box.")));
  await expect.element(page.getByText("This is a box.", { exact: true })).toBeVisible();
});

test.each([
  {
    label: "network",
    respond: () => Promise.reject(new TypeError("Failed to fetch")),
    expectedError: ai.en.networkError,
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
])("$label failure preserves the scene and provides a resend path", async ({ label, respond, expectedError }) => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  mockModelFetch().mockImplementation(respond);
  await addPrimitive();
  await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a sphere"));
  await click(page.getByRole("button", { name: "Send prompt" }));

  await expect
    .element(page.getByRole("region", { name: "Modra", exact: true }).getByRole("status").last())
    .toHaveTextContent("Request failed");
  await expect.element(page.getByRole("alert").getByText(expectedError)).toBeInTheDocument();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Add a sphere");
  expect(document.querySelectorAll(".ai-message")).toHaveLength(label === "tool protocol" ? 2 : 1);
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
  const fetchMock = mockModelFetch().mockResolvedValue(
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
  const dialog = page.getByRole("dialog", { name: "AI service settings" });
  await click(dialog.getByRole("button", { name: "Remove saved API key" }));
  expect(dialog.element().querySelector('[role="status"]')).toBeNull();
  await expect.element(dialog.getByRole("button", { name: "Remove saved API key" })).not.toBeInTheDocument();
  expect(loadAIProviderSettings()?.apiKey).toBeUndefined();

  await click(dialog.getByRole("button", { name: "Close AI service settings" }));
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
  const fetchMock = mockModelFetch().mockResolvedValue(
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

  await click(page.getByRole("button", { name: "Modra", exact: true }));
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
  expect(body.messages).toEqual([
    { role: "system", content: expect.stringContaining("fresh bounded hierarchy") },
    { role: "user", content: "Add a cube" },
  ]);
  expect(body.tools).toHaveLength(MODELING_COMMANDS.length + MODELING_QUERIES.length + 1);
  expect(body.tools.map((entry: { function: { name: string } }) => entry.function.name)).toContain("update_task_plan");
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
  const fetchMock = mockModelFetch()
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

  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt" }));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  const proposal = page.getByRole("region", { name: "Proposed modeling changes" });
  await expect
    .element(proposal.getByText("Previewing 2 proposed changes on the canvas", { exact: true }))
    .toBeInTheDocument();
  const transcript = page.getByLabelText(ai.en.messages, { exact: true });
  await expect
    .element(transcript.getByText('{"primitive":"box","name":"AI box"}', { exact: true }))
    .toBeInTheDocument();
  await expect
    .element(transcript.getByText('{"primitive":"uv-sphere","name":"AI sphere"}', { exact: true }))
    .toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await click(proposal.getByRole("button", { name: decision }));

  if (decision === "Accept changes") {
    await expect.element(proposal.getByRole("button", { name: "Accept changes" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "AI box", exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "AI sphere", exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("These changes are present in the current scene.", { exact: true }))
      .toBeInTheDocument();
    await click(page.getByRole("button", { name: "Undo" }));
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    await expect.element(page.getByText("These changes were undone.", { exact: true })).toBeInTheDocument();
    await click(page.getByRole("button", { name: "Redo" }));
    expect(document.querySelectorAll(".object-row")).toHaveLength(2);
    await expect
      .element(page.getByText("These changes are present in the current scene.", { exact: true }))
      .toBeInTheDocument();
    await click(page.getByRole("button", { name: "Undo" }));
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
  await click(page.getByRole("button", { name: "My 桌子 的操作", exact: true }));
  await expect.element(page.getByRole("menuitem", { name: "隐藏 My 桌子" })).toBeVisible();
  await act(async () => userEvent.keyboard("{Escape}"));
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
  mockModelFetch().mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "消息" }), "Build my 自定义桌子"));
  await click(page.getByRole("button", { name: "发送提示词" }));
  await expect.element(page.getByRole("alert").getByText(ai["zh-CN"].networkError, { exact: true })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "消息" })).toHaveValue("Build my 自定义桌子");
  await expect.element(page.getByText("user-model-name", { exact: true })).toBeVisible();
  await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language: "en" }));
  await expect
    .element(
      page.getByRole("alert").getByText(ai.en.networkError, {
        exact: true,
      }),
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
      getComputedStyle(
        page
          .getByRole("dialog", { name: "AI service settings", exact: true })
          .element()
          .querySelector(".ai-settings-dialog")!,
      ).backgroundColor,
    ).toBe(toRgb(rootStyle.getPropertyValue("--sheet")));
    await expect.element(page.getByRole("textbox", { name: "URL" })).toBeVisible();
    await click(page.getByRole("button", { name: "Close AI service settings" }));
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
    expect(document.querySelector("#viewport-navigation-help")).toBeNull();
  },
);
test("preserves canvas geometry, draft and property editing while the AI floating window opens and closes", async () => {
  await addPrimitive();
  const canvas = document.querySelector("canvas")!;
  const before = canvas.getBoundingClientRect().toJSON();
  expect(document.querySelector('[data-testid="topbar"]')!.textContent).not.toContain("AI");
  await expect.element(page.getByRole("button", { name: "Open AI service settings" })).not.toBeInTheDocument();
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
  await click(toggle);
  const dialog = page.getByRole("dialog", { name: "Modra", exact: true });
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().getAttribute("aria-modal")).not.toBe("true");
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(before);
  await expect.element(page.getByRole("textbox", { name: "Object name" })).toBeVisible();
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Keep this draft"));
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
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
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
  const before = toggle.element().getBoundingClientRect();
  const canvas = document.querySelector("canvas")!;
  const canvasBounds = canvas.getBoundingClientRect().toJSON();
  await act(async () => userEvent.dragAndDrop(toggle, page.getByRole("heading", { name: "Objects", exact: true })));
  const after = toggle.element().getBoundingClientRect();
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.y).toBeLessThan(before.y - 100);
  expect(after.x).toBeGreaterThanOrEqual(16);
  await expect.element(page.getByRole("dialog", { name: "Modra", exact: true })).not.toBeInTheDocument();
  expect(canvas.getBoundingClientRect().toJSON()).toEqual(canvasBounds);
  await click(toggle);
  await expect.element(page.getByRole("dialog", { name: "Modra", exact: true })).toBeVisible();
});

test("repositions the floating AI launcher with keyboard controls and clamps it after resize", async () => {
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
  const before = toggle.element().getBoundingClientRect();
  await act(async () => {
    toggle.element().focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
  });
  const moved = toggle.element().getBoundingClientRect();
  expect(moved.x).toBe(before.x - 10);
  expect(moved.y).toBe(before.y - 10);
  await expect.element(page.getByRole("dialog", { name: "Modra", exact: true })).not.toBeInTheDocument();
  await page.viewport(390, 500);
  await expect.poll(() => toggle.element().getBoundingClientRect().right).toBeLessThanOrEqual(390 - 16);
  expect(toggle.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(500 - 16);
  await click(toggle);
  const bounds = page.getByRole("dialog", { name: "Modra", exact: true }).element().getBoundingClientRect();
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
  "anchors Modra beside the $horizontal/$vertical corner at $width without clipping",
  async ({ width, horizontal, vertical }) => {
    await page.viewport(width, 844);
    const toggle = page.getByRole("button", { name: "Modra", exact: true });
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
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
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

test.each([
  { width: 390, height: 500, language: "en", theme: "light" },
  { width: 768, height: 900, language: "en", theme: "dark" },
  { width: 1440, height: 900, language: "zh-CN", theme: "light" },
] as const)(
  "groups Modra session, execution and context controls at $width/$language",
  async ({ width, height, language, theme }) => {
    await page.viewport(width, height);
    await initializeI18n(language);
    document.documentElement.classList.toggle("dark", theme === "dark");
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "model-with-a-long-identifier-for-layout-verification",
    });
    mockModelFetch().mockResolvedValue(
      chatTextResponse(
        "layout",
        language === "en"
          ? "I will build the base, stem and shade as separate objects, then align them in the scene."
          : "我会将灯座、支架和灯罩分别建模，然后在场景中对齐。",
      ),
    );
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    const dialog = page.getByTestId("ai-floating-dialog");
    const prompt = page.getByRole("textbox", { name: ai[language].message, exact: true });
    await fill(prompt, language === "en" ? "Build a reading lamp" : "创建一盏台灯");
    await settleAIPosition();
    const bounds = dialog.element().getBoundingClientRect();
    const heading = dialog.element().querySelector(".ai-conversation-heading")!.getBoundingClientRect();
    const modes = dialog.element().querySelector(".modra-mode-controls")!.getBoundingClientRect();
    const context = dialog.element().querySelector(".modra-context-controls")!.getBoundingClientRect();
    const transcript = dialog.element().querySelector(".ai-transcript")!.getBoundingClientRect();
    expect(heading.top).toBeGreaterThanOrEqual(bounds.top);
    expect(transcript.height).toBeGreaterThanOrEqual(80);
    const body = dialog.element().querySelector(".ai-conversation-body")!.getBoundingClientRect();
    expect(transcript.top).toBeGreaterThanOrEqual(body.top);
    expect(transcript.bottom).toBeLessThanOrEqual(body.bottom);
    expect(prompt.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(modes.top);
    expect(Math.abs((modes.top + modes.bottom) / 2 - (context.top + context.bottom) / 2)).toBeLessThanOrEqual(1);
    expect(modes.right).toBeLessThanOrEqual(context.left);
    expect(heading.bottom).toBeLessThanOrEqual(body.top);
    expect(context.bottom).toBeLessThanOrEqual(bounds.bottom);
    for (const button of dialog.element().querySelectorAll(".ai-prompt-form button")) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))).toBe(true);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await click(page.getByRole("button", { name: ai[language].send, exact: true }));
    await expect
      .element(page.getByText(language === "en" ? "Response complete" : ai[language].complete, { exact: true }))
      .toBeInTheDocument();
  },
);

test("keeps centrally anchored chat readable on a short narrow viewport", async () => {
  await page.viewport(390, 500);
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
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
  expect(composer.height).toBe(32);
});

test("does not flicker between vertical and horizontal placements during a native drag across the side-fit boundary", async () => {
  await page.viewport(900, 1000);
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
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
    await expect.element(page.getByRole("dialog", { name: "Modra", exact: true })).toBeVisible();
  } finally {
    observer.disconnect();
    await act(async () =>
      session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse(449), button: "left", clickCount: 1 }),
    );
  }
});

test("retains vertical placement around the center line until the opposite side has meaningfully more room", async () => {
  await page.viewport(390, 1000);
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
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
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
  await click(toggle);
  const dialog = page.getByTestId("ai-floating-dialog").element();
  expect(getComputedStyle(dialog).transitionProperty).toBe("opacity, scale");
  expect(parseFloat(getComputedStyle(dialog).transitionDuration)).toBeGreaterThan(0);
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Preserved through transition"));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Close Modra", exact: true })));
  expect(dialog.hasAttribute("data-ending-style")).toBe(true);
  expect(dialog.hasAttribute("hidden")).toBe(false);
  await expect.poll(() => dialog.getAnimations().length).toBeGreaterThan(0);
  await click(toggle);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveValue("Preserved through transition");
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  await expect.poll(() => dialog.hasAttribute("hidden")).toBe(true);
  await act(async () => userEvent.click(toggle));
  await expect.poll(() => dialog.getAnimations().length).toBeGreaterThan(0);
  await settleAIPosition();
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  await expect.poll(() => dialog.hasAttribute("hidden")).toBe(true);
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await click(toggle);
    expect(getComputedStyle(dialog).transitionProperty).toBe("none");
    expect(dialog.getAnimations()).toHaveLength(0);
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
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
  const toggle = page.getByRole("button", { name: "Modra", exact: true });
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
    await expect.element(page.getByRole("dialog", { name: "Modra", exact: true })).not.toBeInTheDocument();
    await act(async () => {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touch(after.x + 28, after.y + 28)],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    });
    await expect.element(page.getByRole("region", { name: "Modra", exact: true })).toBeVisible();
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
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    await expect.element(page.getByRole("textbox", { name: zh ? "消息" : "Message" })).toBeVisible();
    expect(document.querySelector("canvas")!.getBoundingClientRect().toJSON()).toEqual(canvasBounds);
    noOverflow();
    await click(page.getByRole("button", { name: zh ? "关闭 Modra" : "Close Modra", exact: true }));
    expect(document.querySelector("canvas")).toBe(initialCanvas);
  },
);
test.each(["manual edit", "undo", "credential removal"])(
  "invalidates an AI preview after %s before approval",
  async (change) => {
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
      apiKey: "test-credential",
    });
    await addPrimitive();
    const commit = vi.spyOn(WorkspaceModelingHost.prototype, "commit");
    const fetch = mockModelFetch()
      .mockResolvedValueOnce(
        chatToolCallResponse("stale", "command_scene_createPrimitive", { primitive: "box", name: "Obsolete box" }),
      )
      .mockResolvedValueOnce(chatTextResponse("stale-summary", "Review this box."));
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Add another box"),
    );
    await click(page.getByRole("button", { name: "Send prompt", exact: true }));
    await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).toBeVisible();
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
    if (change === "undo") await click(page.getByRole("button", { name: "Undo", exact: true }));
    else if (change === "credential removal")
      await act(async () => {
        removeAIProviderCredential();
      });
    else await addPrimitive("cylinder");
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("AI preview · not applied", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The scene or connection changed. Generate a fresh proposal before applying changes.");
    expect(commit).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(".object-row")).toHaveLength(
      change === "undo" ? 0 : change === "credential removal" ? 1 : 2,
    );
  },
);

test("duplicate AI commit callbacks cannot apply a batch again, including after Undo", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const commit = vi.spyOn(WorkspaceModelingHost.prototype, "commit");
  mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("once", "command_scene_createPrimitive", { primitive: "box", name: "Single box" }),
    )
    .mockResolvedValueOnce(chatTextResponse("once-summary", "Review."))
    .mockResolvedValueOnce(chatTextResponse("once-done", "Done."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Add one box"));
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await click(page.getByRole("button", { name: "Accept changes", exact: true }));
  await expect.element(page.getByText("Done.", { exact: true })).toBeVisible();
  const host = commit.mock.contexts[0] as WorkspaceModelingHost;
  const [id, base, commands] = commit.mock.calls[0]!;
  expect(() => host.commit(id, host.snapshot().version, commands)).toThrow("already-applied-change-set");
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  await click(page.getByRole("button", { name: "Undo", exact: true }));
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  expect(() => host.commit(id, base, commands)).toThrow("stale-change-set");
  expect(() => host.commit(id, host.snapshot().version, commands)).toThrow("already-applied-change-set");
  expect(host.processor.historyLength).toBe(0);
  await click(page.getByRole("button", { name: "Redo", exact: true }));
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
});

test("removing credentials aborts an active staged run without retry or continuation", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
    apiKey: "temporary-test-key",
  });
  const summary = controlledChatResponse("credential-revoked");
  const fetch = mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("credential-preview", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Revoked preview",
      }),
    )
    .mockResolvedValueOnce(summary.response);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Create a box"));
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await expect.element(page.getByText("AI preview · not applied", { exact: true })).toBeVisible();
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  await act(async () => {
    removeAIProviderCredential();
  });
  await expect.element(page.getByRole("button", { name: "Cancel request", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("AI preview · not applied", { exact: true })).not.toBeInTheDocument();
  await act(async () => {
    summary.text("Late response");
    summary.finish();
  });
  await expect.element(page.getByText("Late response", { exact: true })).not.toBeInTheDocument();
  expect(document.querySelectorAll(".object-row")).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(loadAIProviderSettings()?.apiKey).toBeUndefined();
});

test.each([
  { width: 390, theme: "light", language: "en" },
  { width: 768, theme: "dark", language: "zh-CN" },
  { width: 1440, theme: "dark", language: "en" },
  { width: 1440, theme: "light", language: "zh-CN" },
] as const)(
  "preserves suspended Modra reading through errors and reopen at $width/$theme/$language",
  async ({ width, theme, language }) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme, language }));
    await page.viewport(width, 844);
    const zh = language === "zh-CN";
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      modelId: "test-model",
    });
    const stream = controlledChatResponse("reading");
    mockModelFetch().mockResolvedValueOnce(stream.response);
    const canvas = document.querySelector("canvas")!;
    const geometry = canvas.getBoundingClientRect().toJSON();
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true }), "Explain the model"),
    );
    await click(page.getByRole("button", { name: zh ? "发送提示词" : "Send prompt", exact: true }));
    const text = Array.from({ length: 100 }, (_, index) => `${zh ? "建模细节" : "Modeling detail"} ${index}`).join(
      "\n\n",
    );
    await act(async () => stream.text(text));
    await expect
      .element(page.getByText(`${zh ? "建模细节" : "Modeling detail"} 99`, { exact: true }))
      .toBeInTheDocument();
    const transcript = document.querySelector<HTMLDivElement>(".ai-transcript")!;
    await expect.poll(() => transcript.scrollHeight - transcript.clientHeight).toBeGreaterThan(500);
    await expect
      .poll(() => transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop)
      .toBeLessThanOrEqual(1);
    await act(async () => {
      transcript.scrollTop = 120;
      transcript.dispatchEvent(new Event("scroll"));
    });
    const bottom = page.getByRole("button", { name: zh ? "返回底部" : "Return to bottom", exact: true });
    await expect.element(bottom).toBeVisible();
    const top = transcript.scrollTop;
    await act(async () => stream.text(`\n${text}`));
    expect(transcript.scrollTop).toBe(top);
    await act(async () => stream.fail());
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(transcript.scrollTop).toBe(top);
    await click(page.getByRole("button", { name: zh ? "关闭 Modra" : "Close Modra", exact: true }));
    await click(page.getByRole("button", { name: zh ? "Modra" : "Modra", exact: true }));
    await expect.element(bottom).toBeVisible();
    expect(transcript.scrollTop).toBe(top);
    expect(canvas.getBoundingClientRect().toJSON()).toEqual(geometry);
    expect(bottom.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      document.querySelector(".ai-prompt-form")!.getBoundingClientRect().top,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await click(bottom);
    await expect
      .poll(() => transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop)
      .toBeLessThanOrEqual(1);
  },
);

test("late tool responses cannot preview or commit into an imported scene with the same document ID", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const snapshot = vi.spyOn(WorkspaceModelingHost.prototype, "snapshot");
  let resolveOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const fetch = mockModelFetch()
    .mockReturnValueOnce(oldResponse)
    .mockResolvedValueOnce(chatTextResponse("new-scene", "New scene only."));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  const oldVersion = snapshot.mock.results.at(-1)!.value!;
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Old task"));
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await expect.element(page.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  const replacement = createProcessor(emptyDocument());
  expect(replacement.getDocumentSnapshot().id).toBe(oldVersion.document.id);
  replacement.executeCommand({
    commandId: "scene.createPrimitive",
    arguments: { primitive: "cylinder", name: "Replacement only" },
  });
  await act(async () =>
    userEvent.upload(
      page.getByLabelText("Project or glTF files"),
      new File([serializeNativeProject(replacement.getDocumentSnapshot())], "replacement.open3d", {
        type: "application/vnd.open-3d.project+json",
      }),
    ),
  );
  await expect.element(page.getByRole("button", { name: "Replacement only", exact: true })).toBeInTheDocument();
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await act(async () => {
    resolveOld(chatToolCallResponse("late", "command_scene_createPrimitive", { primitive: "box", name: "Late box" }));
  });
  await act(async () =>
    userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Inspect replacement"),
  );
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await expect.element(page.getByText("New scene only.", { exact: true })).toBeVisible();
  expect(snapshot.mock.results.at(-1)!.value!.version.generationId).not.toBe(oldVersion.version.generationId);
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect.element(page.getByText("AI preview · not applied", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Accept changes", exact: true })).not.toBeInTheDocument();
});
test("a manual edit during an automatic batch prevents its late summary from committing", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  let finish!: (response: Response) => void;
  const summary = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const commit = vi.spyOn(WorkspaceModelingHost.prototype, "commit");
  const fetch = mockModelFetch()
    .mockResolvedValueOnce(
      chatToolCallResponse("auto-stale", "command_scene_createPrimitive", {
        primitive: "box",
        name: "Obsolete automatic box",
      }),
    )
    .mockReturnValueOnce(summary);
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await click(page.getByRole("button", { name: "Approval mode", exact: true }));
  await click(page.getByRole("menuitemradio", { name: "Auto-approve", exact: true }));
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Message", exact: true }), "Add a box"));
  await click(page.getByRole("button", { name: "Send prompt", exact: true }));
  await expect.element(page.getByText("AI preview · not applied", { exact: true })).toBeVisible();
  await expect.poll(() => fetch.mock.calls.length).toBe(2);
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  await addPrimitive("cylinder");
  await act(async () => finish(chatTextResponse("late-auto-summary", "Apply obsolete automatic box now.")));
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The scene or connection changed. Generate a fresh proposal before applying changes.");
  expect(commit).not.toHaveBeenCalled();
  expect(document.querySelectorAll(".object-row")).toHaveLength(1);
  expect(document.querySelector(".object-row")!.textContent).toContain("Cylinder");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  { protocol: "openai-responses", label: "OpenAI Responses", fixture: responsesFixture, language: "en", width: 390 },
  {
    protocol: "anthropic-messages",
    label: "Anthropic Messages",
    fixture: anthropicFixture,
    language: "en",
    width: 390,
  },
  { protocol: "gemini", label: "Gemini", fixture: geminiFixture, language: "en", width: 390 },
  {
    protocol: "openai-responses",
    label: "OpenAI Responses",
    fixture: responsesFixture,
    language: "zh-CN",
    width: 1440,
  },
  {
    protocol: "anthropic-messages",
    label: "Anthropic Messages",
    fixture: anthropicFixture,
    language: "zh-CN",
    width: 1440,
  },
  { protocol: "gemini", label: "Gemini", fixture: geminiFixture, language: "zh-CN", width: 1440 },
] as const)(
  "configures $protocol and reviews native modeling tools at $width/$language",
  async ({ protocol, label, fixture: nativeFixture, language, width }) => {
    await act(async () => {
      await page.viewport(width, 900);
      useWorkspaceUiStore
        .getState()
        .updateDisplayPreferences({ theme: language === "en" ? "light" : "dark", language });
    });
    const zh = language === "zh-CN";
    await openAISettings();
    const settings = page.getByRole("dialog", { name: zh ? "AI 服务设置" : "AI service settings", exact: true });
    await click(settings.getByRole("combobox", { name: zh ? "协议" : "Protocol", exact: true }));
    await click(page.getByRole("option", { name: label, exact: true }));
    await act(async () => {
      await userEvent.fill(
        settings.getByRole("textbox", { name: "URL", exact: true }),
        "https://models.example.test/v1",
      );
      await userEvent.fill(settings.getByRole("textbox", { name: zh ? "模型" : "Model", exact: true }), "test-model");
    });
    await click(settings.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
    expect(loadAIProviderSettings()).toMatchObject({ protocol, route: "direct", modelId: "test-model" });
    const fetchMock = mockModelFetch()
      .mockResolvedValueOnce(
        nativeFixture({
          id: "native-box",
          name: "command_scene_createPrimitive",
          input: { primitive: "box", name: "Native box" },
        }),
      )
      .mockImplementation(async () => nativeFixture(undefined, "Native result"));
    await act(async () =>
      userEvent.fill(page.getByRole("textbox", { name: zh ? "消息" : "Message", exact: true }), "Build a box"),
    );
    await click(page.getByRole("button", { name: zh ? "发送提示词" : "Send prompt", exact: true }));
    await expect
      .element(page.getByRole("button", { name: zh ? "接受更改" : "Accept changes", exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll(".object-row")).toHaveLength(0);
    await click(page.getByRole("button", { name: zh ? "接受更改" : "Accept changes", exact: true }));
    await expect.poll(() => document.querySelectorAll(".object-row").length).toBe(1);
    await expect.element(page.getByText(zh ? "响应完成" : "Response complete", { exact: true })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await openAISettings();
    await expect
      .element(settings.getByRole("combobox", { name: zh ? "协议" : "Protocol", exact: true }))
      .toHaveTextContent(label);
  },
);
test("first scene save adopts Modra history and reopens it without leaking into a duplicate", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example/v1",
    modelId: "test-model",
  });
  const fetch = mockModelFetch().mockImplementation(async () =>
    chatTextResponse("adopted", "History for the original project"),
  );
  const repo = new IndexedDBModraRepository();
  const store = createLocalProjectStore();
  try {
    await addPrimitive();
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    const input = page.getByRole("textbox", { name: ai.en.message, exact: true });
    await act(async () => userEvent.fill(input, "Remember the original scene"));
    await click(page.getByRole("button", { name: ai.en.send, exact: true }));
    await expect.element(page.getByText("History for the original project", { exact: true })).toBeVisible();
    const [session] = await repo.list();
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
    await click(page.getByRole("button", { name: "Save", exact: true }));
    await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
    const [project] = await store.list();
    expect(await repo.scopeForProject(project!.id)).toBe(session!.scopeId);
    const duplicate = await store.duplicate(project!.id, "Separate copy");
    await act(async () => root.unmount());
    await drainModraClosures();
    root = createRoot(container);
    await act(async () => root.render(<WorkspaceApp />));
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    const manager = page.getByRole("dialog", { name: "Projects", exact: true });
    await act(async () =>
      userEvent.fill(manager.getByRole("textbox", { name: "Search projects", exact: true }), project!.name),
    );
    await click(manager.getByRole("button", { name: "Open", exact: true }));
    await expect.poll(() => document.querySelector(".project-name")?.textContent).toContain(project!.name);
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await expect.element(page.getByText("History for the original project", { exact: true })).toBeVisible();
    expect(await repo.list(session!.scopeId)).toHaveLength(1);
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    await act(async () =>
      userEvent.fill(manager.getByRole("textbox", { name: "Search projects", exact: true }), duplicate.name),
    );
    await click(manager.getByRole("button", { name: "Open", exact: true }));
    await expect.poll(() => document.querySelector(".project-name")?.textContent).toContain(duplicate.name);
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    expect(document.querySelector(".ai-transcript")?.textContent).not.toContain("History for the original");
    expect(await repo.scopeForProject(duplicate.id)).toBe(`project:${duplicate.id}`);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    await repo.close();
    store.close?.();
  }
});
test.each(["streaming", "review"] as const)(
  "deleting the active project during %s fences durable work and re-save cannot resurrect history",
  async (phase) => {
    saveAIProviderSettings({
      protocol: "openai-compatible",
      baseURL: "https://models.example/v1",
      modelId: "test-model",
    });
    const stream = controlledChatResponse("deleted");
    const fetch = mockModelFetch();
    if (phase === "streaming") fetch.mockResolvedValueOnce(stream.response);
    else
      fetch
        .mockResolvedValueOnce(
          chatToolCallResponse("preview", "command_scene_createPrimitive", { primitive: "box", name: "Unconfirmed" }),
        )
        .mockResolvedValueOnce(chatTextResponse("review", "Review this preview"));
    const repo = new IndexedDBModraRepository();
    const store = createLocalProjectStore();
    try {
      await addPrimitive();
      await click(page.getByRole("button", { name: "Save", exact: true }));
      await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
      const [project] = await store.list();
      await click(page.getByRole("button", { name: "Modra", exact: true }));
      await act(async () =>
        userEvent.fill(page.getByRole("textbox", { name: ai.en.message }), "Work belonging to the deleted project"),
      );
      await click(page.getByRole("button", { name: ai.en.send, exact: true }));
      if (phase === "streaming") {
        await act(async () => stream.text("Before deletion"));
        await expect.element(page.getByText("Before deletion", { exact: true })).toBeVisible();
      } else await expect.element(page.getByRole("button", { name: ai.en.accept, exact: true })).toBeEnabled();
      await expect.poll(async () => (await repo.list()).length).toBe(1);
      const [record] = await repo.list();
      await click(page.getByRole("button", { name: "Close Modra", exact: true }));
      await click(page.getByRole("button", { name: "Open projects", exact: true }));
      const manager = page.getByRole("dialog", { name: "Projects", exact: true });
      await click(manager.getByRole("button", { name: /^Manage / }));
      await click(page.getByRole("menuitem", { name: "Delete", exact: true }));
      await click(
        page
          .getByRole("dialog", { name: "Delete project?", exact: true })
          .getByRole("button", { name: "Delete", exact: true }),
      );
      await expect.poll(async () => (await store.list()).length).toBe(0);
      await expect.poll(async () => (await repo.list(record!.scopeId)).length).toBe(0);
      await click(manager.getByRole("button", { name: "Close projects", exact: true }));
      await act(async () => {
        stream.text("Late output must be ignored");
        stream.finish();
      });
      expect(document.querySelectorAll(".object-row")).toHaveLength(1);
      expect(document.querySelector(".viewport-canvas")?.getAttribute("data-ai-preview")).not.toBe("true");
      await click(page.getByRole("button", { name: "Save", exact: true }));
      await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
      const [replacement] = await store.list();
      expect(replacement!.id).not.toBe(project!.id);
      expect(await repo.scopeForProject(replacement!.id)).not.toBe(record!.scopeId);
      await click(page.getByRole("button", { name: "Modra", exact: true }));
      expect(document.querySelector(".ai-transcript")?.textContent).not.toContain("Work belonging");
      expect(document.querySelector(".ai-transcript")?.textContent).not.toContain("Late output");
      expect(fetch).toHaveBeenCalledTimes(phase === "streaming" ? 1 : 2);
    } finally {
      await repo.close();
      store.close?.();
    }
  },
);

test.each(["unavailable", "newer-version", "corrupt", "quota"] as const)(
  "Modra storage %s does not prevent independent native scene save or opening",
  async (code) => {
    const repo = new IndexedDBModraRepository();
    const store = createLocalProjectStore();
    vi.spyOn(repo, "prepareProjectScope").mockRejectedValue(new ModraStorageError(code));
    vi.spyOn(repo, "scopeForProject").mockRejectedValue(new ModraStorageError(code));
    try {
      await act(async () => {
        root.unmount();
        root = createRoot(container);
        root.render(<WorkspaceApp projectStore={store} modraRepository={repo} />);
      });
      await addPrimitive();
      await click(page.getByRole("button", { name: "Save", exact: true }));
      await expect.poll(() => document.querySelector(".save-state")?.textContent).toBe("Saved");
      const [project] = await store.list();
      expect(Object.keys((await store.load(project!.id)).objects)).toHaveLength(1);
      await click(page.getByRole("button", { name: "Open projects", exact: true }));
      await click(
        page.getByRole("dialog", { name: "Projects", exact: true }).getByRole("button", { name: "Open", exact: true }),
      );
      await expect.element(page.getByRole("button", { name: "Box", exact: true })).toBeVisible();
      expect(document.querySelectorAll(".object-row")).toHaveLength(1);
      expect(await repo.list()).toEqual([]);
    } finally {
      await repo.close();
      store.close?.();
    }
  },
);
test("launcher robot reflects idle, hidden generation, completion and failure without changing its hit target", async () => {
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  const stream = controlledChatResponse("robot");
  const fetch = mockModelFetch()
    .mockResolvedValueOnce(stream.response)
    .mockResolvedValueOnce(new Response("Denied", { status: 401 }));
  const launcher = page.getByRole("button", { name: "Modra", exact: true });
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "idle");
  const before = launcher.element().getBoundingClientRect();
  await click(launcher);
  await fill(page.getByRole("textbox", { name: ai.en.message }), "Create a lamp");
  await click(page.getByRole("button", { name: ai.en.send }));
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "generating");
  await click(page.getByRole("button", { name: "Close Modra", exact: true }));
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "generating");
  await act(async () => {
    stream.text("The lamp is ready.");
    stream.finish();
  });
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "completed");
  expect(launcher.element().getBoundingClientRect().width).toBe(before.width);
  expect(launcher.element().getBoundingClientRect().height).toBe(before.height);
  await click(launcher);
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "idle");
  await fill(page.getByRole("textbox", { name: ai.en.message }), "Adjust the lamp");
  await click(page.getByRole("button", { name: ai.en.send }));
  await expect.element(launcher).toHaveAttribute("data-modra-activity", "error");
  expect(fetch).toHaveBeenCalledTimes(2);
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    expect(getComputedStyle(launcher.element().querySelector(".modra-robot-head")!).animationName).toBe("none");
    expect(launcher.element().querySelector("svg")?.getAttribute("data-activity")).toBe("error");
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
test.for([390, 768, 1440])("keeps timestamp and compact copy aligned in message headers at %i", async (width) => {
  await page.viewport(width, 900);
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    modelId: "test-model",
  });
  mockModelFetch().mockImplementation(async () =>
    chatTextResponse("layout", "The reading lamp is ready.\n\nReview the shade and base before the next step."),
  );
  await click(page.getByRole("button", { name: "Modra", exact: true }));
  await fill(page.getByRole("textbox", { name: ai.en.message }), "Build a reading lamp");
  await click(page.getByRole("button", { name: ai.en.send }));
  await expect.element(page.getByText("Response complete", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: ai.en.sessions, exact: true })).toHaveTextContent("Modeling");
  const headers = document.querySelectorAll<HTMLElement>(".ai-message-header");
  expect(headers).toHaveLength(2);
  const articles = Array.from(document.querySelectorAll<HTMLElement>(".ai-message"));
  expect(articles[0].getBoundingClientRect().left).toBe(articles[1].getBoundingClientRect().left);
  expect(articles[0].getBoundingClientRect().width).toBe(articles[1].getBoundingClientRect().width);
  expect(
    page.getByRole("button", { name: "Close Modra", exact: true }).element().querySelector(".lucide-minus"),
  ).not.toBeNull();
  for (const header of headers) {
    const time = header.querySelector("time")!;
    const copy = header.querySelector("button")!;
    const bounds = header.getBoundingClientRect();
    const button = copy.getBoundingClientRect();
    expect(time.textContent?.length).toBeGreaterThan(0);
    expect(button.width).toBe(24);
    expect(Math.abs(button.right - bounds.right)).toBeLessThanOrEqual(1);
    expect(button.left).toBeGreaterThanOrEqual(time.getBoundingClientRect().right);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  if (width === 390) {
    await expect
      .element(page.getByRole("button", { name: "Modra", exact: true }), { timeout: 6000 })
      .toHaveAttribute("data-modra-activity", "idle");
  }
});
test.each(["en", "zh-CN"] as const)(
  "creates a project from manager chrome without losing unsaved work in %s",
  async (language) => {
    await act(async () => useWorkspaceUiStore.getState().updateDisplayPreferences({ theme: "light", language }));
    const zh = language === "zh-CN";
    const store = createLocalProjectStore();
    const start = async () => {
      await click(page.getByRole("button", { name: zh ? "打开项目" : "Open projects", exact: true }));
      const dialog = page.getByRole("dialog", { name: zh ? "项目" : "Projects", exact: true });
      const create = dialog.getByRole("button", { name: zh ? "新建项目" : "New project", exact: true });
      const close = dialog.getByRole("button", { name: zh ? "关闭项目" : "Close projects", exact: true });
      expect(create.element().getBoundingClientRect().right).toBeLessThanOrEqual(
        close.element().getBoundingClientRect().left,
      );
      await click(create);
    };
    try {
      expect(document.querySelector(".project-name")!.textContent).toContain("Untitled project");
      await addPrimitive();
      await start();
      const confirm = page.getByRole("dialog", { name: zh ? "未保存的更改" : "Unsaved changes", exact: true });
      await expect.element(confirm).toBeVisible();
      await click(confirm.getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }));
      expect(document.querySelectorAll(".object-row")).toHaveLength(1);
      await start();
      await click(confirm.getByRole("button", { name: zh ? "保存并继续" : "Save and continue", exact: true }));
      await expect.poll(() => document.querySelectorAll(".object-row").length).toBe(0);
      expect(document.querySelector(".project-name")!.textContent).toContain(zh ? "未命名项目" : "Untitled project");
      const [original] = await store.list();
      expect((await store.load(original!.id)).objects).toHaveLength(1);
      await expect.element(page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true })).toBeDisabled();
      await addPrimitive("cylinder");
      await click(page.getByRole("button", { name: zh ? "保存" : "Save", exact: true }));
      await expect.poll(async () => (await store.list()).length).toBe(2);
      expect((await store.load(original!.id)).objects).toHaveLength(1);
      await addPrimitive();
      await start();
      await click(confirm.getByRole("button", { name: zh ? "放弃更改" : "Discard", exact: true }));
      await expect.poll(() => document.querySelectorAll(".object-row").length).toBe(0);
      expect(await store.list()).toHaveLength(2);
      await start();
      await expect.element(confirm).not.toBeInTheDocument();
    } finally {
      store.close?.();
    }
  },
);

test("abandoning an unsaved project removes its Modra session instead of creating other-project history", async () => {
  saveAIProviderSettings({ protocol: "openai-compatible", baseURL: "https://models.example/v1", modelId: "test" });
  mockModelFetch().mockResolvedValue(chatTextResponse("abandoned", "Temporary work"));
  const repo = new IndexedDBModraRepository();
  try {
    await addPrimitive();
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await fill(page.getByRole("textbox", { name: ai.en.message, exact: true }), "Temporary modeling question");
    await click(page.getByRole("button", { name: ai.en.send, exact: true }));
    await expect.element(page.getByText("Temporary work", { exact: true })).toBeVisible();
    const [record] = await repo.list();
    expect(record).toBeDefined();
    await click(page.getByRole("button", { name: "Close Modra", exact: true }));
    await click(page.getByRole("button", { name: "Open projects", exact: true }));
    await click(page.getByRole("button", { name: "New project", exact: true }));
    await click(page.getByRole("button", { name: "Discard", exact: true }));
    await expect.poll(async () => await repo.load(record!.id)).toBeNull();
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    await click(page.getByRole("button", { name: ai.en.sessions, exact: true }));
    expect(page.getByRole("dialog", { name: ai.en.sessions, exact: true }).element().textContent).not.toContain(
      "Temporary",
    );
    expect(await repo.list()).toHaveLength(0);
  } finally {
    await repo.close();
  }
});

test.each([390, 768, 1440])(
  "keeps compact composer, pale placeholders and tight object menus at %ipx",
  async (width) => {
    await page.viewport(width, 900);
    await addPrimitive();
    if (width < 1000)
      await click(
        page
          .getByRole("navigation", { name: "Workspace panels" })
          .getByRole("button", { name: "Objects", exact: true }),
      );
    await click(page.getByRole("button", { name: /^Actions for / }));
    const menu = page.getByRole("menu");
    await expect.element(menu.getByRole("menuitem", { name: /^Hide / })).toHaveTextContent("Hide");
    expect(menu.element().getBoundingClientRect().width).toBeLessThan(150);
    await act(async () => userEvent.keyboard("{Escape}"));
    await click(page.getByRole("button", { name: "Modra", exact: true }));
    const input = page.getByRole("textbox", { name: ai.en.message, exact: true }).element();
    expect(input.getBoundingClientRect().height).toBe(32);
    expect(page.getByRole("button", { name: ai.en.send, exact: true }).element().getBoundingClientRect().width).toBe(
      32,
    );
    expect(getComputedStyle(input, "::placeholder").color).not.toBe(getComputedStyle(input).color);
    expect(getComputedStyle(document.querySelector(".ai-conversation-body")!).paddingTop).toBe("0px");
  },
);