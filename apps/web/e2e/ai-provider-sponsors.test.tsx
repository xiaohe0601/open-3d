/// <reference types="vite/client" />
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AI_PROVIDER_SETTINGS_STORAGE_KEY } from "@open-3d/ai/settings";
import { initializeI18n } from "../src/i18n";
import { WorkspaceApp } from "../src/app";
import "../src/style.css";
import { AIProviderSettingsDialog } from "../src/workspace/ai-provider-settings-dialog";
import { AI_PROVIDER_SPONSORS_URL } from "../src/workspace/ai-provider-sponsors-data";
import * as sponsorsData from "../src/workspace/ai-provider-sponsors-data";

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

test.each(["network", "invalid", "empty"])("keeps settings usable when the feed is %s", async (state) => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  if (state === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  else fetchMock.mockResolvedValue(new Response(state === "invalid" ? "not JSON" : "[]"));
  await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
  await expect.element(page.getByRole("region", { name: "Sponsored providers", exact: true })).not.toBeInTheDocument();
  await act(async () =>
    userEvent.fill(page.getByRole("textbox", { name: "URL", exact: true }), "https://example.com/v1"),
  );
  await act(async () => userEvent.fill(page.getByRole("textbox", { name: "Model", exact: true }), "test-model"));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Save", exact: true })));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

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
  await act(async () => userEvent.click(page.getByRole("button", { name: "AI chat", exact: true })));
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