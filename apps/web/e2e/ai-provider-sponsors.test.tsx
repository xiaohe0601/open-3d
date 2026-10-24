/// <reference types="vite/client" />
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AI_PROVIDER_SETTINGS_STORAGE_KEY, saveAIProviderSettings } from "@open-3d/ai/settings";
import { initializeI18n } from "../src/i18n";
import { WorkspaceApp } from "../src/app";
import "../src/style.css";
import { AIProviderSettingsDialog } from "../src/workspace/ai-provider-settings-dialog";
import { AI_PROVIDER_SPONSORS_URL } from "../src/workspace/ai-provider-sponsors-data";
import * as sponsorsData from "../src/workspace/ai-provider-sponsors-data";
import { ai } from "../src/i18n/ai";

vi.mock("../src/workspace/ai-provider-sponsors-data", { spy: true });

let root: Root;
let container: HTMLDivElement;
const onOpenChange = vi.fn();
const feed = [
  {
    id: "sakura",
    name: "桜 API",
    description: "高速稳定不降智，倍率低至 0.15",
    link: "https://api.gyh.one/sign-up?aff=xn0R",
  },
];

beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  localStorage.removeItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  onOpenChange.mockClear();
  // Each test represents a fresh page; dialog remounts within it share the same loader.
  vi.mocked(sponsorsData.loadAIProviderSponsors).mockImplementation(sponsorsData.createAIProviderSponsorsLoader());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.classList.remove("dark");
  localStorage.removeItem(AI_PROVIDER_SETTINGS_STORAGE_KEY);
  vi.restoreAllMocks();
});

test.each([
  { width: 390, language: "en", dark: false },
  { width: 1440, language: "zh-CN", dark: true },
] as const)(
  "renders labeled promotion links without changing settings at $width in $language",
  async ({ width, language, dark }) => {
    await page.viewport(width, 800);
    await initializeI18n(language);
    document.documentElement.classList.toggle("dark", dark);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(feed)));
    await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
    const section = page.getByRole("region", {
      name: language === "en" ? "Sponsored providers" : "服务商推广",
      exact: true,
    });
    await expect.element(section).toBeVisible();
    const link = section.getByRole("link", { name: /桜 API/ });
    await expect.element(link).toHaveAttribute("href", feed[0].link);
    await expect.element(link).toHaveAttribute("rel", "sponsored noopener noreferrer");
    await expect.element(link).toHaveAttribute("target", "_blank");
    expect(fetchMock.mock.calls[0][0]).toBe(AI_PROVIDER_SPONSORS_URL);
    expect(section.element().getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await expect.element(page.getByRole("textbox", { name: "URL", exact: true })).toHaveValue("");
    expect(localStorage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY)).toBeNull();
    await act(async () => root.render(<AIProviderSettingsDialog open={false} onOpenChange={onOpenChange} />));
    await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
    await expect.element(section).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test.each(["en", "zh-CN"] as const)("context capacity can be configured and reopened in %s", async (language) => {
  await initializeI18n(language);
  await page.viewport(language === "en" ? 1440 : 390, 800);
  const labels = ai[language];
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
  saveAIProviderSettings({
    protocol: "openai-compatible",
    baseURL: "https://models.example/v1",
    modelId: "test-model",
  });
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  await act(async () => userEvent.click(page.getByText(labels.contextSettings, { exact: true })));
  const capacity = page.getByRole("spinbutton", { name: labels.contextWindowTokens, exact: true });
  await expect.element(capacity).toBeVisible();
  const unit = capacity.element().parentElement!.querySelector("span")!;
  expect(unit.textContent).toBe(labels.contextTokenUnit);
  expect(unit.getBoundingClientRect().right).toBeLessThanOrEqual(capacity.element().getBoundingClientRect().right);
  await expect.element(page.getByText(labels.contextWindowNotice, { exact: true })).toBeVisible();
  await act(async () => userEvent.fill(capacity, "65536"));
  await act(async () => userEvent.click(page.getByRole("button", { name: labels.saveSettings, exact: true })));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(JSON.parse(localStorage.getItem(AI_PROVIDER_SETTINGS_STORAGE_KEY)!).settings.contextWindowTokens).toBe(65536);
  await act(async () => root.render(<AIProviderSettingsDialog open={false} onOpenChange={onOpenChange} />));
  await expect
    .element(page.getByRole("dialog", { name: labels.providerSettings, exact: true }))
    .not.toBeInTheDocument();
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  const summary = page.getByText(labels.contextSettings, { exact: true });
  await expect.element(summary).toBeVisible();
  if (!summary.element().closest("details")!.open) await act(async () => userEvent.click(summary));
  await expect.element(capacity).toHaveValue(65536);
});

test.each(["network", "invalid", "empty"])("keeps settings usable when the feed is %s", async (state) => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  if (state === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  else fetchMock.mockResolvedValue(new Response(state === "invalid" ? "not JSON" : "[]"));
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  await expect.element(page.getByRole("region", { name: "Sponsored providers", exact: true })).not.toBeInTheDocument();
  expect(document.querySelector(".ai-settings-dialog")!.getBoundingClientRect().width).toBeLessThanOrEqual(480);
  await act(async () =>
    userEvent.fill(page.getByRole("textbox", { name: "URL", exact: true }), "https://example.com/v1"),
  );
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Model", exact: true }), "test-model"));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Save", exact: true })));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test.each([
  { width: 390, height: 500, language: "en", dark: false },
  { width: 768, height: 900, language: "en", dark: true },
  { width: 1440, height: 900, language: "zh-CN", dark: false },
] as const)(
  "places promotions beside desktop settings and after the mobile form at $width/$height",
  async ({ width, height, language, dark }) => {
    await page.viewport(width, height);
    await initializeI18n(language);
    document.documentElement.classList.toggle("dark", dark);
    saveAIProviderSettings({
      protocol: "openai-compatible",
      route: "self-hosted",
      baseURL: "https://example.com/v1",
      modelId: "model",
      gatewayURL: "https://gateway.example.com",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 8 }, (_, index) => ({
            ...feed[0],
            id: `provider-${index}`,
            name: `${feed[0].name} ${index}`,
            description: feed[0].description.repeat(8),
          })),
        ),
      ),
    );
    await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
    const promotion = page.getByRole("region", {
      name: language === "en" ? "Sponsored providers" : "服务商推广",
      exact: true,
    });
    await expect.element(promotion.getByRole("link").first()).toBeVisible();
    const dialog = document.querySelector<HTMLElement>(".ai-settings-dialog")!;
    const scroll = dialog.querySelector<HTMLElement>(".ai-settings-scroll")!;
    const link = promotion.getByRole("link").first().element().getBoundingClientRect();
    const protocol = dialog.querySelector("#ai-protocol")!.getBoundingClientRect();
    const save = page.getByRole("button", { name: language === "en" ? "Save" : "保存", exact: true });
    const bounds = dialog.getBoundingClientRect();
    const promoBounds = promotion.element().getBoundingClientRect();
    if (width >= 1024) {
      expect(link.top).toBeGreaterThanOrEqual(16);
      expect(link.bottom).toBeLessThanOrEqual(height - 16);
      expect(promoBounds.width).toBe(320);
      expect(promoBounds.left).toBeGreaterThanOrEqual(bounds.right + 12);
      expect(promoBounds.top).toBeCloseTo(bounds.top, 0);
    } else {
      expect(scroll.contains(promotion.element())).toBe(true);
      expect(promoBounds.top).toBeGreaterThanOrEqual(dialog.querySelector("form")!.getBoundingClientRect().bottom);
      expect(promoBounds.width).toBeLessThanOrEqual(scroll.clientWidth);
    }
    expect(protocol.top).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().top);
    expect(protocol.bottom).toBeLessThanOrEqual(scroll.getBoundingClientRect().bottom);
    expect(save.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(bounds.height).toBeLessThanOrEqual(height - 32);
    expect(
      dialog.querySelector("#ai-api-key")!.compareDocumentPosition(dialog.querySelector("#ai-route")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () => {
      scroll.scrollTop = scroll.scrollHeight;
    });
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const movedTop = promotion.getByRole("link").first().element().getBoundingClientRect().top;
    if (width >= 1024) expect(movedTop).toBeCloseTo(link.top, 0);
    else {
      expect(movedTop).toBeLessThan(link.top);
      await act(async () => promotion.getByRole("link").first().element().scrollIntoView({ block: "center" }));
      await expect.element(promotion.getByRole("link").first()).toBeVisible();
    }
    await expect.element(save).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);

test("shares a pending request across closing and reopening settings", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<AIProviderSettingsDialog open={false} onOpenChange={onOpenChange} />));
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<AIProviderSettingsDialog open={false} onOpenChange={onOpenChange} />));
  await act(async () => {
    resolve(new Response(JSON.stringify(feed)));
  });
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  await expect.element(page.getByRole("region", { name: "Sponsored providers", exact: true })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("preloads promotions at workspace startup and reuses them when settings open", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<WorkspaceApp />));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(AI_PROVIDER_SPONSORS_URL);
  await expect.element(page.getByRole("dialog", { name: "AI provider settings" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
  await act(async () => {
    resolve(new Response(JSON.stringify(feed)));
  });
  await act(async () => userEvent.click(page.getByRole("button", { name: "Modra", exact: true })));
  await expect.element(page.getByRole("button", { name: "Open AI provider settings", exact: true })).toBeVisible();
  await act(async () => userEvent.click(page.getByRole("button", { name: "Open AI provider settings", exact: true })));
  await expect.element(page.getByRole("region", { name: "Sponsored providers", exact: true })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("keeps the workspace usable when startup promotion loading fails", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => root.render(<WorkspaceApp />));
  await expect.element(page.getByRole("application", { name: "Interactive 3D scene" })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("moves the single promotion surface across breakpoints without resetting provider edits or fetching again", async () => {
  await page.viewport(390, 844);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(feed)));
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  const promotion = page.getByRole("region", { name: "Sponsored providers", exact: true });
  await expect.element(promotion).toBeInTheDocument();
  await act(async () =>
    userEvent.fill(page.getByRole("textbox", { name: "URL", exact: true }), "https://draft.example/v1"),
  );
  for (const width of [1440, 768, 1024, 390]) {
    await act(async () => page.viewport(width, 844));
    await expect
      .poll(() => {
        const scroll = document.querySelector(".ai-settings-scroll")!;
        return scroll.contains(promotion.element());
      })
      .toBe(width < 1024);
    expect(promotion.elements()).toHaveLength(1);
    await expect
      .element(page.getByRole("textbox", { name: "URL", exact: true }))
      .toHaveValue("https://draft.example/v1");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([390, 768, 1440])("keeps expanded safety notice neutral and balanced at %ipx", async (width) => {
  await page.viewport(width, 900);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(feed)));
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  const trigger = page.getByRole("button", { name: ai.en.credentialSummary, exact: true });
  await userEvent.hover(page.getByRole("heading", { name: ai.en.providerSettings, exact: true }));
  const before = getComputedStyle(trigger.element()).backgroundColor;
  await act(async () => userEvent.click(trigger));
  await userEvent.hover(page.getByRole("heading", { name: ai.en.providerSettings, exact: true }));
  await expect.poll(() => getComputedStyle(trigger.element()).backgroundColor).toBe(before);
  const notice = document.querySelector("#ai-credential-notice")!;
  expect(getComputedStyle(notice).paddingTop).toBe(getComputedStyle(notice).paddingBottom);
  await expect
    .element(page.getByRole("combobox", { name: ai.en.protocol, exact: true }))
    .toHaveTextContent("OpenAI Compatible");
});