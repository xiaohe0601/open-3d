import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, test, expect, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { AIProviderSettingsDialog } from "../src/workspace/ai-provider-settings-dialog";
import { loadAIProviderSettings, saveAIProviderSettings } from "@open-3d/ai/settings";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { click } from "./helpers/workspace";
import "../src/style.css";

vi.mock("../src/modra/controller/official-gateway", () => ({
  officialGatewayURL: "https://official.example.org",
  officialTurnstileSiteKey: "test-sitekey",
  officialGatewayAvailable: true,
}));

vi.mock("../src/workspace/ai-provider-sponsors-data", () => ({ loadAIProviderSponsors: async () => [] }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test.each([
  { language: "en", width: 1440 },
  { language: "zh-CN", width: 390 },
] as const)(
  "validates explicit Modra routes and independent credentials at $width/$language",
  async ({ language, width }) => {
    const labels = ai[language];
    await initializeI18n(language);
    await page.viewport(width, 900);
    saveAIProviderSettings({
      protocol: "openai-compatible",
      route: "direct",
      baseURL: "https://models.example/v1",
      modelId: "test",
      apiKey: "sentinel-provider",
    });
    const onOpenChange = vi.fn();
    await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
    await click(page.getByRole("combobox", { name: labels.route }));
    await expect
      .element(page.getByRole("option", { name: labels.routes.official, exact: true }))
      .not.toHaveAttribute("aria-disabled", "true");
    await click(page.getByRole("option", { name: labels.routes.official, exact: true }));
    await expect.element(page.getByText(labels.routeNotice.official, { exact: true })).toBeVisible();
    await click(page.getByRole("combobox", { name: labels.route }));
    await click(page.getByRole("option", { name: labels.routes["self-hosted"], exact: true }));
    await expect.element(page.getByText(labels.routeNotice["self-hosted"], { exact: true })).toBeVisible();
    const url = page.getByLabelText(labels.gatewayURL, { exact: true });
    await act(async () => url.fill("http://untrusted.example"));
    await click(page.getByRole("button", { name: labels.saveSettings, exact: true }));
    await expect.element(page.getByText(labels.gatewayURLInvalid, { exact: true })).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => url.fill("https://gateway.example.org"));
    await act(async () => page.getByLabelText(labels.gatewayToken, { exact: false }).fill("sentinel-gateway"));
    await click(page.getByRole("button", { name: labels.saveSettings, exact: true }));
    expect(loadAIProviderSettings()).toMatchObject({
      route: "self-hosted",
      gatewayToken: "sentinel-gateway",
      apiKey: "sentinel-provider",
    });
    // Reopen from storage so removal tests exercise the saved, not merely edited, token.
    await act(async () => root.render(<AIProviderSettingsDialog open={false} onOpenChange={onOpenChange} />));
    await act(async () => root.render(<AIProviderSettingsDialog open onOpenChange={onOpenChange} />));
    await click(page.getByRole("button", { name: labels.removeGatewayCredential }));
    expect(loadAIProviderSettings()).toMatchObject({ apiKey: "sentinel-provider" });
    expect(loadAIProviderSettings()).not.toHaveProperty("gatewayToken");
    await click(page.getByRole("combobox", { name: labels.route }));
    await click(page.getByRole("option", { name: labels.routes.direct, exact: true }));
    await click(page.getByRole("button", { name: labels.saveSettings, exact: true }));
    expect(loadAIProviderSettings()).toEqual({
      protocol: "openai-compatible",
      route: "direct",
      baseURL: "https://models.example/v1",
      modelId: "test",
      apiKey: "sentinel-provider",
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  },
);