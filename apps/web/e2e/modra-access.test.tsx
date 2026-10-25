import { mockModelFetch } from "./helpers/model-fetch";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { saveAIProviderSettings, removeAIProviderCredential } from "@open-3d/ai/settings";
import type { AIProviderSettings } from "@open-3d/ai/settings";
import { AIConversationPanel } from "../src/workspace/ai-conversation-panel";
import { WorkspaceModelingHost } from "../src/modra/controller/workspace-host";
import { createProcessor } from "../src/workspace/modeling";
import { initializeI18n } from "../src/i18n";
import { ai } from "../src/i18n/ai";
import { chatTextResponse } from "../../../tests/fixtures/ai/chat-completions";
import { waitForModraIdle, click, waitForModraReady } from "./helpers/workspace";
import { drainModraClosures } from "../src/modra/controller/use-modra-controller";
import { MODRA_DATABASE_NAME } from "../src/modra/storage/indexeddb-repository";
import "../src/style.css";

vi.mock("../src/modra/controller/official-gateway", () => ({
  officialGatewayURL: "https://official.example.org",
  officialTurnstileSiteKey: "test-sitekey",
  officialGatewayAvailable: true,
}));
vi.mock("@open-3d/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@open-3d/ai")>();
  return {
    ...actual,
    createModraProvider: (options: Parameters<typeof actual.createModraProvider>[0]) =>
      actual.createModraProvider({ ...options, retryTiming: { initialDelayMs: 0 } }),
  };
});

const requestURL = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

let root: Root;
let container: HTMLDivElement;
const settings = (route: AIProviderSettings["route"]): AIProviderSettings => {
  const base = {
    protocol: "openai-compatible" as const,
    baseURL: "https://models.example/v1",
    modelId: "test-model",
    apiKey: "test-provider-key",
  };
  return route === "self-hosted"
    ? { ...base, route, gatewayURL: "https://self.example.org", gatewayToken: "test-gateway-token" }
    : { ...base, route };
};
function capabilities(route: string) {
  return Response.json({
    version: 1,
    enabled: true,
    protocols: ["openai-compatible"],
    auth: route === "official" ? "turnstile-grant" : "deployment-token",
    limits: { requestBytes: 50331648, idleMs: 60000, totalMs: 600000, concurrent: 2 },
  });
}
async function mount(route: AIProviderSettings["route"]) {
  saveAIProviderSettings(settings(route));
  const host = new WorkspaceModelingHost(createProcessor(), "temp:test", () => crypto.randomUUID());
  await act(async () =>
    root.render(
      <div style={{ height: 700, maxWidth: 480, display: "flex" }}>
        <AIConversationPanel active modelingHost={host} settingsRevision={0} onOpenSettings={() => {}} />
      </div>,
    ),
  );
  await waitForModraReady();
}
async function send(text = "Describe this scene") {
  await act(async () => page.getByRole("textbox", { name: ai.en.message, exact: true }).fill(text));
  await click(page.getByRole("button", { name: ai.en.send, exact: true }));
}
beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  localStorage.clear();
  await initializeI18n("en");
  await page.viewport(390, 900);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.turnstile = {
    render: vi.fn((element, options) => {
      expect(options.action).toBe("modra-relay");
      expect(options.sitekey).toBe("test-sitekey");
      const button = document.createElement("button");
      button.textContent = "Verify test access";
      button.onclick = () => options.callback("test-challenge-token");
      element.append(button);
      return "test-widget";
    }),
    remove: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  await drainModraClosures();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MODRA_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Session database is still open"));
  });
  container.remove();
  delete window.turnstile;
  vi.restoreAllMocks();
});

test.each(["direct", "official", "self-hosted"] as const)(
  "runs Modra through the explicitly selected %s route without leaking gateway credentials",
  async (route) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mockModelFetch().mockImplementation(async (input, init) => {
      const url = requestURL(input);
      calls.push({ url, init });
      if (url.endsWith("capabilities")) return capabilities(route);
      if (url.endsWith("access"))
        return Response.json({ version: 1, token: "test-grant", expiresAt: Date.now() + 300000 });
      return chatTextResponse("test", "Scene inspected successfully");
    });
    await mount(route);
    await send();
    if (route === "official") {
      await expect.element(page.getByRole("dialog", { name: ai.en.gatewayVerification })).toBeVisible();
      expect(calls).toHaveLength(1);
      await click(page.getByRole("button", { name: "Verify test access" }));
    }
    await expect.element(page.getByText("Scene inspected successfully", { exact: true })).toBeVisible();
    await waitForModraIdle();
    await expect.element(page.getByRole("textbox", { name: ai.en.message, exact: true })).toBeEnabled();
    const count = calls.length;
    await send("Describe it again");
    await waitForModraIdle();
    await expect.element(page.getByRole("textbox", { name: ai.en.message, exact: true })).toBeEnabled();
    expect(calls).toHaveLength(count + 1);
    if (route === "direct") {
      expect(calls.every((call) => call.url === "https://models.example/v1/chat/completions")).toBe(true);
      expect(window.turnstile!.render).not.toHaveBeenCalled();
    } else {
      const relay = calls.find((call) => call.url.endsWith("relay"))!;
      const headers = new Headers(relay.init!.headers);
      expect(headers.get("authorization")).toBe("Bearer test-provider-key");
      expect(headers.get("x-open-3d-gateway-token")).toBe(route === "official" ? "test-grant" : "test-gateway-token");
      expect(headers.get("x-open-3d-upstream")).toBe("https://models.example/v1/chat/completions");
      expect(relay.init!.body).not.toContain("test-gateway-token");
      expect(relay.init!.body).not.toContain("test-grant");
      expect(calls.some((call) => call.url.startsWith("https://models.example"))).toBe(false);
      expect(JSON.stringify(calls[0])).not.toContain("test-provider-key");
      const access = calls.find((call) => call.url.endsWith("access"));
      if (route === "official") {
        expect(access!.init!.body).toBe('{"token":"test-challenge-token"}');
        expect(new Headers(access!.init!.headers).get("authorization")).toBeNull();
      } else expect(access).toBeUndefined();
    }
    expect(Object.values(localStorage).join(" ")).not.toContain("test-grant");
    expect(Object.values(localStorage).join(" ")).not.toContain("test-challenge-token");
    expect(container.textContent).not.toContain("test-provider-key");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
);

test.each([
  { offset: 60_000, legacy: true },
  { offset: -3_600_000, legacy: true },
  { offset: 3_600_000, legacy: false },
  { offset: -3_600_000, legacy: false },
])("official access tolerates server clock offset $offset (legacy: $legacy)", async ({ offset, legacy }) => {
  let exchanges = 0;
  let relays = 0;
  mockModelFetch().mockImplementation(async (input, init) => {
    const url = requestURL(input);
    if (url.endsWith("capabilities")) return capabilities("official");
    if (url.endsWith("access")) {
      exchanges++;
      const serverNow = Date.now() + offset;
      return Response.json({
        version: 1,
        token: "test-grant",
        ...(legacy ? {} : { issuedAt: serverNow }),
        expiresAt: serverNow + 300_000,
      });
    }
    expect(url).toBe("https://official.example.org/v1/relay");
    expect(new Headers(init?.headers).get("X-Open-3D-Gateway-Token")).toBe("test-grant");
    relays++;
    return chatTextResponse("test", "Gateway request completed");
  });
  await mount("official");
  await send();
  await click(page.getByRole("button", { name: "Verify test access" }));
  await expect.element(page.getByText("Gateway request completed", { exact: true })).toBeVisible();
  await waitForModraIdle();
  await send("Continue");
  await waitForModraIdle();
  expect(exchanges).toBe(1);
  expect(relays).toBe(2);
  expect(window.turnstile!.render).toHaveBeenCalledOnce();
});

test("official verification can be cancelled and retried without a request or stuck spinner", async () => {
  const dispatch = mockModelFetch().mockImplementation(async (input) => {
    if (requestURL(input).endsWith("capabilities")) return capabilities("official");
    throw new Error("Must not send provider credentials");
  });
  await mount("official");
  await send();
  const dialog = page.getByRole("dialog", { name: ai.en.gatewayVerification });
  await expect.element(page.getByRole("button", { name: "Verify test access" })).toBeVisible();
  await click(dialog.getByRole("button", { name: ai.en.cancelRequest }));
  await expect.element(page.getByText(ai.en.gatewayChallengeError, { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: ai.en.message, exact: true }))
    .toHaveValue("Describe this scene");
  expect(dispatch).toHaveBeenCalledTimes(1);
  await click(page.getByRole("button", { name: ai.en.send }));
  await expect.element(page.getByRole("button", { name: "Verify test access" })).toBeVisible();
  await act(async () => removeAIProviderCredential());
  await expect.element(dialog).not.toBeInTheDocument();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(window.turnstile!.remove).toHaveBeenCalled();
});

test("self-hosted auth denial is recoverable and is not a provider authentication error", async () => {
  let permitted = false;
  const dispatch = mockModelFetch().mockImplementation(async (input) => {
    if (requestURL(input).endsWith("capabilities")) return capabilities("self-hosted");
    return permitted
      ? chatTextResponse("recovered", "Recovered gateway connection")
      : Response.json({ error: { code: "gateway.auth" } }, { status: 401 });
  });
  await mount("self-hosted");
  await send();
  await expect.element(page.getByText(ai.en.gatewayAuthError, { exact: true })).toBeVisible();
  expect(dispatch).toHaveBeenCalledTimes(2);
  permitted = true;
  await click(page.getByRole("button", { name: ai.en.send }));
  await expect.element(page.getByText("Recovered gateway connection", { exact: true })).toBeVisible();
  expect(dispatch).toHaveBeenCalledTimes(3);
  expect(window.turnstile!.render).not.toHaveBeenCalled();
});

test.each([
  { status: 401, code: "provider-auth", upstream: true, label: ai.en.authError, attempts: 1 },
  { status: 429, code: "provider-rate", upstream: true, label: ai.en.rateError, attempts: 6 },
  { status: 403, code: "gateway.target", upstream: false, label: ai.en.gatewayPolicyError, attempts: 1 },
  { status: 429, code: "gateway.rate", upstream: false, label: ai.en.gatewayRateError, attempts: 6 },
  { status: 413, code: "gateway.request-size", upstream: false, label: ai.en.gatewaySizeError, attempts: 1 },
  { status: 503, code: "gateway.configuration", upstream: false, label: ai.en.gatewayConfigurationError, attempts: 1 },
])("distinguishes $code in the real provider/runtime path", async ({ status, code, upstream, label, attempts }) => {
  let relays = 0;
  mockModelFetch().mockImplementation(async (input) => {
    if (requestURL(input).endsWith("capabilities")) return capabilities("self-hosted");
    relays++;
    return Response.json(
      { error: { code, message: "private-sentinel-diagnostic" } },
      {
        status,
        headers: { "Retry-After": "0", ...(upstream ? { "X-Open-3D-Error": "upstream" } : {}) },
      },
    );
  });
  await mount("self-hosted");
  await send();
  await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  expect(relays).toBe(attempts);
  expect(container.textContent).not.toContain("private-sentinel-diagnostic");
  expect(container.textContent).not.toContain("test-gateway-token");
});